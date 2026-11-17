import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { accountId, forAccount, parseLedger, totals } from "./ledger.ts";
import { type CustomAgent, ACP_PLUGIN_ID, AGENT_ID, readLegacyEntry, removeLegacyEntry, userEnv } from "./legacy-entry.ts";
import { DISPLAY_NAME, PROVIDER_ID, envFileContent, isTakenError, parseExtraEnv, providerDeclaration } from "./provider.ts";

// Claude Code on AWS Bedrock as a bb provider:
// - registers the provider "acp-claude-bedrock" itself (provider.ts): bb runs
//   this plugin's bin/claude-bedrock-acp through the SDK's ACP bridge, which the
//   plugin's bb.host entry (host.ts) re-exports. The declaration adds bb's
//   permission modes, /compact and forks (side chats);
// - hands the provider over from earlier versions, which registered it as a
//   customAgents entry in bb's ACP agents plugin: removes that entry (keeping
//   the user's own variables), waits until that plugin drops the provider, and
//   registers it. Threads store only the provider id, so they keep working;
// - writes the settings to an env file the launcher reads on every start, and
//   the API key (a secret setting) to a 0600 key file the env file names;
// - adds `bb acp-claude-bedrock status | repair`; when registering fails, bb
//   shows the plugin as needing configuration;
// - publishes estimated spend for bb's Provider usage panel/footer through the
//   provider-usage RPC methods below.
const PACKAGE_NAME = "bb-plugin-acp-claude-bedrock";
const LIST_RESOURCES = "provider-usage.v1.listResources";
const GET_RESOURCE = "provider-usage.v1.getResource";

const LEDGER = join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "claude-bedrock", "cost.jsonl");

const window = z.object({
  kind: z.enum(["five-hour", "daily", "weekly", "custom"]),
  id: z.string().min(1),
  label: z.string().min(1),
  usedPercent: z.number().nonnegative(),
  resetsAt: z.string().nullable(),
  model: z.string().nullable(),
  cost: z.object({ usedUsdCents: z.number().nonnegative(), limitUsdCents: z.number().positive() }).nullable(),
});
const common = { plan: z.null(), accountEmail: z.string().nullable(), planLabel: z.string().nullable() };
const usageState = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), ...common, windows: z.array(window) }),
  z.object({ status: z.literal("error"), ...common, message: z.string() }),
]);

export const usageRpcContract = defineRpcContract({
  [LIST_RESOURCES]: {
    input: z.object({}),
    output: z.object({
      resources: z.array(z.object({
        accountKey: z.string().min(1).nullable(),
        id: z.string().min(1),
        providerId: z.string().min(1),
        label: z.string().min(1),
        scope: z.object({ kind: z.literal("host"), hostId: z.string().min(1), hostName: z.string().min(1) }),
      })),
    }),
  },
  [GET_RESOURCE]: {
    input: z.object({ resourceId: z.string().min(1), refresh: z.boolean() }),
    output: z.object({ accountKey: z.string().min(1).nullable(), observedAt: z.number().int().nonnegative().nullable(), usage: usageState }),
  },
});

const cents = (usd: number) => Math.round(usd * 100);
const usd = (amount: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount);

const ADAPTER = join("node_modules", "@agentclientprotocol", "claude-agent-acp");

type Settings = {
  apiKey?: string;
  region: string;
  awsProfile?: string;
  adapterCommand?: string;
  sandbox: boolean;
  priceFactor: number;
  extraEnv?: string;
};

/** The agent's environment for these settings; keyFile is the API key file's path when there is a key. */
export function agentEnvFor(s: Settings, keyFile: string | undefined): Record<string, string | undefined> {
  return {
    // the user's own variables first, so the settings below win
    ...parseExtraEnv(s.extraEnv),
    AWS_REGION: s.region.trim() || "us-east-1",
    AWS_PROFILE: s.awsProfile?.trim(),
    CLAUDE_AGENT_ACP: s.adapterCommand?.trim(),
    CLAUDE_BEDROCK_PRICE_FACTOR: String(s.priceFactor > 0 ? s.priceFactor : 1),
    CLAUDE_BEDROCK_KEY_FILE: keyFile,
    // only the opt-out is set, so the default leaves the entry unchanged
    CLAUDE_BEDROCK_SANDBOX: s.sandbox === false ? "0" : undefined,
  };
}

const HANDOVER_ATTEMPTS = 40;
const HANDOVER_DELAY_MS = 250;

/**
 * Registers the provider, handing it over from bb's ACP agents plugin when that
 * still holds the id (an earlier version's customAgents entry): removes the
 * entry, then retries until that plugin has dropped the provider. Throws when
 * the id stays taken.
 */
export async function registerWithHandover(deps: {
  register: () => { dispose(): void };
  removeLegacyEntry: () => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  attempts?: number;
}): Promise<{ registration: { dispose(): void }; handedOver: boolean }> {
  const attempts = deps.attempts ?? HANDOVER_ATTEMPTS;
  let removed = false;
  for (let attempt = 0; ; attempt++) {
    try {
      return { registration: deps.register(), handedOver: removed };
    } catch (error) {
      if (!isTakenError(error)) throw error;
      if (!removed) removed = await deps.removeLegacyEntry();
      if (attempt + 1 >= attempts) {
        throw new Error(
          removed
            ? `${ACP_PLUGIN_ID} still holds the provider ${PROVIDER_ID} after its entry was removed`
            : `the provider ${PROVIDER_ID} is registered by another plugin (see: bb provider list)`,
        );
      }
      await deps.sleep(HANDOVER_DELAY_MS);
    }
  }
}

const isExecutable = (path: string) => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** The bundled adapter's version, or null when it isn't installed. */
function bundledAdapterVersion(pluginDir: string): string | null {
  try {
    const manifest: unknown = JSON.parse(readFileSync(join(pluginDir, ADAPTER, "package.json"), "utf8"));
    const version = (manifest as { version?: unknown }).version;
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

type CliResult = { exitCode: number; stdout?: string; stderr?: string };

/** The Bedrock API key from the macOS keychain item the launcher also reads, if any. */
function keychainToken(): Promise<string | null> {
  if (process.platform !== "darwin") return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(
      "/usr/bin/security",
      ["find-generic-password", "-a", process.env.USER ?? "", "-s", "claude-bedrock-token", "-w"],
      { timeout: 5000, encoding: "utf8" },
      (error, stdout) => resolve(error ? null : stdout.trim() || null),
    );
  });
}

/** This plugin's root: the nearest folder up from the bundle with our package.json. */
function findPluginDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest) && readFileSync(manifest, "utf8").includes(`"${PACKAGE_NAME}"`)) return dir;
    dir = dirname(dir);
  }
  throw new Error(`${PACKAGE_NAME}: could not find the plugin folder from ${fileURLToPath(import.meta.url)}`);
}

export default function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    apiKey: {
      type: "string",
      secret: true,
      label: "Bedrock API key",
      description:
        "Amazon Bedrock API key. Optional: without it, the agent uses the macOS keychain item \"claude-bedrock-token\" if present, else the normal AWS credential chain (AWS profile, SSO, ...).",
    },
    region: {
      type: "string",
      label: "AWS region",
      description: "Bedrock region, e.g. us-east-1 or us-west-2.",
      default: "us-east-1",
    },
    awsProfile: {
      type: "string",
      label: "AWS profile",
      description: "Optional AWS profile for the AWS credential chain, used when no API key is set.",
    },
    adapterCommand: {
      type: "string",
      label: "ACP adapter command",
      description:
        "Optional command that runs @agentclientprotocol/claude-agent-acp, e.g. a pinned install. Default: the adapter bundled with the plugin.",
    },
    sandbox: {
      type: "boolean",
      label: "Bash sandbox in Accept Edits",
      description:
        "Run Claude Code's Bash commands in its OS sandbox when a thread uses Accept Edits, as bb's Claude Code provider does: writes stay inside the workspace, and Claude asks before running a command outside the sandbox. Full Access never uses the sandbox. A change applies when a thread's agent next starts.",
      default: true,
    },
    monthlyBudgetUsd: {
      type: "number",
      label: "Monthly budget (USD)",
      description: "Scale for the usage bar. Today's bar uses this budget divided by the days in the month.",
      default: 100,
    },
    priceFactor: {
      type: "number",
      label: "Price factor",
      description: "Multiplier on Claude Code's list-price cost estimate, for a negotiated Bedrock discount or markup (e.g. 0.8 for 20% below list). Applies to the cost shown in threads and to the usage entry. 1 shows list price.",
      default: 1,
    },
    extraEnv: {
      type: "string",
      label: "Extra environment variables",
      description:
        "Optional NAME=value pairs, separated by spaces, for the agent, e.g. CLAUDE_BEDROCK_ASK_PLAN_APPROVAL=0 or ANTHROPIC_MODEL=... The settings above win over these. A change applies when a thread's agent next starts.",
    },
  });

  const pluginDir = findPluginDir();
  const launcher = join(pluginDir, "bin", "claude-bedrock-acp");

  // The API key is a secret setting (bb keeps it out of its db and the
  // frontend), so it goes into a 0600 file in this plugin's data folder; the
  // env file the launcher reads names only that file's path.
  async function hostDataDir(): Promise<string> {
    let dataDir = process.env.BB_DATA_DIR ?? join(homedir(), ".bb");
    try {
      const config = await bb.sdk.system.config();
      if (config.dataDir.length > 0) dataDir = config.dataDir;
    } catch {
      // keep the default
    }
    return join(dataDir, "plugins", PROVIDER_ID, "host-data");
  }
  const keyFilePath = async () => join(await hostDataDir(), "bedrock-api-key");
  const envFilePath = async () => join(await hostDataDir(), "agent.env");

  /** Writes the key file and the env file from the settings; the launcher reads them on every start. */
  async function writeAgentFiles(): Promise<void> {
    const s = await settings.get();
    const keyFile = await keyFilePath();
    const key = s.apiKey?.trim() ?? "";
    await mkdir(dirname(keyFile), { recursive: true, mode: 0o700 });
    if (key === "") {
      await rm(keyFile, { force: true });
    } else {
      await writeFile(keyFile, `${key}\n`, { mode: 0o600 });
      await chmod(keyFile, 0o600);
    }
    const envFile = await envFilePath();
    await writeFile(envFile, envFileContent(agentEnvFor(s, key === "" ? undefined : keyFile)), { mode: 0o600 });
    await chmod(envFile, 0o600);
  }

  /** Carries the user's own variables from an earlier version's entry over to the Extra environment variables setting. */
  async function carryOverUserEnv(entry: CustomAgent | undefined): Promise<void> {
    const extra = userEnv(entry);
    if (Object.keys(extra).length === 0) return;
    const current = parseExtraEnv((await settings.get()).extraEnv);
    const merged = { ...extra, ...current };
    await settings.experimental_set({ extraEnv: Object.entries(merged).map(([k, v]) => `${k}=${v}`).join(" ") });
    bb.log.info(`Carried over ${Object.keys(extra).join(", ")} from the old agent entry to Extra environment variables`);
  }

  let registration: { dispose(): void } | null = null;

  /** Writes the agent's files, registers the provider (handing it over from an old entry) and removes a leftover entry; true when anything changed. */
  async function setUp(): Promise<boolean> {
    if (!isExecutable(launcher)) throw new Error(`the launcher ${launcher} is missing or not executable; reinstall the plugin`);
    const legacy = await readLegacyEntry(bb);
    if (legacy?.entry !== undefined) await carryOverUserEnv(legacy.entry);
    await writeAgentFiles();
    let changed = false;
    if (registration === null) {
      const declaration = providerDeclaration(launcher, await envFilePath());
      const result = await registerWithHandover({
        register: () => bb.providers.register(declaration),
        removeLegacyEntry: () => removeLegacyEntry(bb),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      });
      registration = result.registration;
      changed = true;
      bb.log.info(`Registered the ${DISPLAY_NAME} provider ${PROVIDER_ID}${result.handedOver ? ` (handed over from ${ACP_PLUGIN_ID})` : ""}`);
    }
    // registered first (e.g. this plugin loaded before the ACP agents plugin): the old entry is only in the way
    if (legacy?.entry !== undefined && (await removeLegacyEntry(bb))) changed = true;
    return changed;
  }

  // one setup at a time; a failure marks the plugin as needing configuration
  let settingUp: Promise<unknown> = Promise.resolve();
  const sync = () => {
    const run = settingUp.then(setUp);
    settingUp = run.catch((error: unknown) => {
      const message = `Could not register the ${DISPLAY_NAME} provider: ${error instanceof Error ? error.message : String(error)}`;
      bb.log.error(message);
      bb.status.needsConfiguration(`${message}. Fix it, then run: bb acp-claude-bedrock repair`);
    });
    return run;
  };

  bb.background.service("provider", {
    async start() {
      await sync().catch(() => {});
    },
  });
  settings.onChange(() => {
    void settingUp.then(writeAgentFiles).catch((error: unknown) => bb.log.error(`Could not write the agent's files: ${String(error)}`));
  });

  async function status(): Promise<CliResult> {
    const s = await settings.get();
    const lines: string[] = [];
    let ok = true;
    const launcherOk = isExecutable(launcher);
    ok &&= launcherOk;
    lines.push(`Launcher: ${launcher}${launcherOk ? "" : " (MISSING or not executable)"}`);
    const bundled = bundledAdapterVersion(pluginDir);
    const adapter = s.adapterCommand?.trim();
    lines.push(
      adapter
        ? `ACP adapter: ${adapter} (ACP adapter command setting)`
        : bundled
          ? `ACP adapter: bundled @agentclientprotocol/claude-agent-acp ${bundled}`
          : "ACP adapter: NOT BUNDLED (run npm install in the plugin folder); falls back to claude-agent-acp on PATH or npx",
    );
    let provider: { pluginId?: string; capabilities?: { supportsFork?: boolean } } | undefined;
    try {
      provider = (await bb.sdk.providers.list()).find((p) => p.id === PROVIDER_ID) as typeof provider;
    } catch {
      // reported as not registered
    }
    const ours = provider?.pluginId === "acp-claude-bedrock";
    ok &&= ours;
    lines.push(
      `bb provider ${PROVIDER_ID}: ${
        provider === undefined
          ? "NOT registered (run: bb acp-claude-bedrock repair)"
          : ours
            ? `registered by this plugin${provider.capabilities?.supportsFork ? ", side chats on" : ""}`
            : `registered by ${provider.pluginId ?? "another plugin"} (run: bb acp-claude-bedrock repair)`
      }`,
    );
    const legacy = await readLegacyEntry(bb);
    if (legacy?.entry !== undefined) {
      ok = false;
      lines.push(`Old ${ACP_PLUGIN_ID} customAgents entry "${AGENT_ID}": LEFTOVER (run: bb acp-claude-bedrock repair)`);
    }
    const envFile = await envFilePath();
    const envOk = existsSync(envFile);
    ok &&= envOk;
    lines.push(`Agent settings file: ${envFile}${envOk ? "" : " (MISSING; run: bb acp-claude-bedrock repair)"}`);
    const credentials = s.apiKey?.trim()
      ? "API key setting"
      : (await keychainToken())
        ? 'macOS keychain item "claude-bedrock-token"'
        : s.awsProfile?.trim()
          ? `AWS profile ${s.awsProfile.trim()}`
          : "AWS credential chain";
    lines.push(`Credentials: ${credentials}`);
    lines.push(`Region: ${s.region.trim() || "us-east-1"}`);
    lines.push(`Bash sandbox in Accept Edits: ${s.sandbox === false ? "off" : "on"}`);
    return { exitCode: ok ? 0 : 1, stdout: `${lines.join("\n")}\n` };
  }

  const commands: Record<string, () => Promise<CliResult>> = {
    status,
    async repair() {
      try {
        const changed = await sync();
        return { exitCode: 0, stdout: `${PROVIDER_ID}: ${changed ? "repaired" : "already up to date"}\n` };
      } catch (error) {
        return { exitCode: 1, stderr: `${error instanceof Error ? error.message : String(error)}\n` };
      }
    },
  };

  bb.cli.register({
    name: "acp-claude-bedrock",
    summary: `Check or repair the ${DISPLAY_NAME} provider.`,
    commands: [
      { name: "status", summary: "Check the launcher, adapter, provider registration and agent settings", usage: "acp-claude-bedrock status" },
      { name: "repair", summary: "Rewrite the agent's settings and register the provider again", usage: "acp-claude-bedrock repair" },
    ],
    async run(argv) {
      const name = argv[0] ?? "status";
      const handler = Object.hasOwn(commands, name) ? commands[name] : undefined;
      if (handler) return handler();
      return { exitCode: 2, stderr: `Unknown subcommand "${name}". Use: bb acp-claude-bedrock status | repair\n` };
    },
  });

  bb.rpc.register(usageRpcContract, {
    [LIST_RESOURCES]: async () => {
      // the ledger lives on this machine: publish it for the bb server's own host
      const [hosts, config] = await Promise.all([bb.sdk.hosts.list(), bb.sdk.system.config().catch(() => null)]);
      const connected = hosts.filter((host) => host.status === "connected");
      const host = connected.find((h) => h.id === config?.primaryHostId) ?? connected[0];
      return {
        resources: host === undefined ? [] : [{
          accountKey: null,
          id: host.id,
          providerId: PROVIDER_ID,
          label: "Claude Code (Bedrock ACP)",
          scope: { kind: "host" as const, hostId: host.id, hostName: host.name },
        }],
      };
    },
    [GET_RESOURCE]: async () => {
      const base = { accountKey: null, observedAt: Date.now() };
      const meta = { plan: null, accountEmail: null, planLabel: "estimate" };
      let text = "";
      try {
        text = await readFile(LEDGER, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          return { ...base, usage: { status: "error" as const, ...meta, message: `Could not read ${LEDGER}.` } };
        }
      }
      const { monthlyBudgetUsd, priceFactor: factor } = await settings.get();
      const discount = factor > 0 ? factor : 1;
      const budget = monthlyBudgetUsd > 0 ? monthlyBudgetUsd : 100;
      const now = new Date();
      // all spend with the credential the agent uses, as the launcher picks it:
      // the API key setting, else the keychain, else the AWS profile or chain
      const creds = await settings.get();
      const apiKey = creds.apiKey?.trim() || (await keychainToken());
      const t = totals(forAccount(parseLedger(text), accountId(apiKey, creds.awsProfile)), now);
      const month = t.month * discount;
      const today = t.today * discount;
      const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      const dailyBudget = budget / daysInMonth;
      const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      return {
        ...base,
        usage: {
          status: "ok" as const,
          ...meta,
          windows: [
            {
              kind: "custom" as const,
              id: "month",
              // the compact footer shows label + percent, so the label carries the dollars
              label: `${now.toLocaleString("en-US", { month: "short" })} ${usd(month)}`,
              usedPercent: (month / budget) * 100,
              resetsAt: nextMonth.toISOString(),
              model: null,
              cost: { usedUsdCents: cents(month), limitUsdCents: Math.max(1, cents(budget)) },
            },
            {
              kind: "custom" as const, // "daily" makes bb render the label as "1d"
              id: "today",
              label: `Today ${usd(today)}`,
              usedPercent: (today / dailyBudget) * 100,
              resetsAt: tomorrow.toISOString(),
              model: null,
              cost: { usedUsdCents: cents(today), limitUsdCents: Math.max(1, cents(dailyBudget)) },
            },
          ],
        },
      };
    },
  }, {
    experimental_discoverable: true,
    experimental_description: "Publishes estimated Claude Code (Bedrock ACP) spend for BB's Provider Usage plugin.",
  });
}
