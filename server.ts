import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { accountId, forAccount, parseLedger, totals } from "./ledger";
import { provisionAgent } from "./agent-entry";

// Claude Code on AWS Bedrock as a bb ACP agent:
// - registers the agent (id "claude-bedrock", provider "acp-claude-bedrock") in
//   bb's ACP agents plugin, pointing at this plugin's own bin/claude-bedrock-acp,
//   on every load (the install folder changes with each plugin update);
// - passes region, price factor and the other settings to that agent through
//   the entry's env; the API key (a secret setting) goes to a 0600 file whose
//   path the launcher gets, so it never lands in the ACP agents config;
// - publishes estimated spend for bb's Provider usage panel/footer through the
//   provider-usage RPC methods below.
const PROVIDER_ID = "acp-claude-bedrock";
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
  });

  const launcher = join(findPluginDir(), "bin", "claude-bedrock-acp");

  // The API key is a secret setting (bb keeps it out of its db and the
  // frontend). bb's ACP agents plugin only passes an agent's configured env to
  // the agent process, so the key goes into a 0600 file in this plugin's data
  // folder and the agent entry carries only that file's path.
  async function keyFilePath(): Promise<string> {
    let dataDir = process.env.BB_DATA_DIR ?? join(homedir(), ".bb");
    try {
      const config = await bb.sdk.system.config();
      if (config.dataDir.length > 0) dataDir = config.dataDir;
    } catch {
      // keep the default
    }
    return join(dataDir, "plugins", "acp-claude-bedrock", "host-data", "bedrock-api-key");
  }

  async function syncKeyFile(apiKey: string | undefined): Promise<string | undefined> {
    const path = await keyFilePath();
    const key = apiKey?.trim() ?? "";
    if (key === "") {
      await rm(path, { force: true });
      return undefined;
    }
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, `${key}\n`, { mode: 0o600 });
    await chmod(path, 0o600);
    return path;
  }

  let syncing = Promise.resolve();
  const sync = () => {
    syncing = syncing
      .then(async () => {
        const s = await settings.get();
        const keyFile = await syncKeyFile(s.apiKey);
        await provisionAgent(bb, launcher, {
          AWS_REGION: s.region.trim() || "us-east-1",
          AWS_PROFILE: s.awsProfile?.trim(),
          CLAUDE_AGENT_ACP: s.adapterCommand?.trim(),
          CLAUDE_BEDROCK_PRICE_FACTOR: String(s.priceFactor > 0 ? s.priceFactor : 1),
          CLAUDE_BEDROCK_KEY_FILE: keyFile,
        });
      })
      .catch((error: unknown) => {
        bb.log.error(`Could not update the Claude Code (Bedrock ACP) agent: ${String(error)}`);
      });
  };
  sync();
  settings.onChange(() => sync());

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
