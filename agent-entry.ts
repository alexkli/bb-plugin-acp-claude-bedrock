import type { BbPluginApi } from "@get-bb/plugin-sdk";

// The agent entry this plugin keeps in bb's ACP agents plugin (provider-acp),
// setting "customAgents": a JSON array of custom agents. bb derives the
// provider id "acp-<id>" from the entry id, so "claude-bedrock" gives
// "acp-claude-bedrock", which existing threads and the usage entry use.
export const ACP_PLUGIN_ID = "provider-acp";
export const AGENT_ID = "claude-bedrock";
export const DISPLAY_NAME = "Claude Code (Bedrock ACP)";

const SETTINGS_READY_ATTEMPTS = 10;
const SETTINGS_READY_DELAY_MS = 500;

type JsonObject = Record<string, unknown>;
type CustomAgent = JsonObject & { id?: unknown; env?: unknown };

const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function parseCustomAgents(value: unknown): CustomAgent[] {
  if (value === undefined || value === null || value === "") return [];
  if (typeof value !== "string") throw new Error(`${ACP_PLUGIN_ID} customAgents must be a string`);
  if (value.trim() === "") return [];
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) throw new Error(`${ACP_PLUGIN_ID} customAgents must be a JSON array; refusing to overwrite it`);
  return parsed as CustomAgent[];
}

/** Env variables this plugin owns in the entry; set from the plugin settings, removed when unset. */
export const MANAGED_ENV = [
  "AWS_REGION",
  "AWS_PROFILE",
  "CLAUDE_AGENT_ACP",
  "CLAUDE_BEDROCK_PRICE_FACTOR",
  "CLAUDE_BEDROCK_KEY_FILE",
] as const;
export type ManagedEnv = Partial<Record<(typeof MANAGED_ENV)[number], string>>;

/** The managed entry: our command, name and env; the user's other env and fields are kept. */
export function managedAgent(launcher: string, managedEnv: ManagedEnv, existing?: CustomAgent): CustomAgent {
  const env: Record<string, unknown> = { ...(isObject(existing?.env) ? existing.env : {}) };
  for (const name of MANAGED_ENV) delete env[name];
  for (const [name, value] of Object.entries(managedEnv)) if (value) env[name] = value;
  return {
    nativeSkillRoots: { user: [".claude/skills"], project: [".claude/skills"] },
    ...(existing ?? {}),
    id: AGENT_ID,
    displayName: DISPLAY_NAME,
    command: launcher,
    args: [],
    env,
  };
}

async function readAgents(bb: BbPluginApi): Promise<CustomAgent[] | null> {
  try {
    const settings = await bb.sdk.plugins.getSettings({ pluginId: ACP_PLUGIN_ID });
    return parseCustomAgents(settings.values.customAgents);
  } catch (error) {
    bb.log.warn(`Could not read ${ACP_PLUGIN_ID} customAgents: ${String(error)}`);
    return null;
  }
}

/**
 * Add or update the agent entry so it runs this plugin's launcher. Runs on every
 * load and settings change: a git or marketplace install lives in a folder named
 * after the commit, so the launcher path changes with each update. Leaves other
 * agents alone and writes nothing when the entry is already current.
 */
export async function provisionAgent(bb: BbPluginApi, launcher: string, managedEnv: ManagedEnv): Promise<boolean> {
  let agents: CustomAgent[] | null = null;
  // the ACP agents plugin may load after this one
  for (let attempt = 0; attempt < SETTINGS_READY_ATTEMPTS && agents === null; attempt += 1) {
    agents = await readAgents(bb);
    if (agents === null) await new Promise((resolve) => setTimeout(resolve, SETTINGS_READY_DELAY_MS));
  }
  if (agents === null) throw new Error(`the ${ACP_PLUGIN_ID} plugin's settings are not available`);

  const index = agents.findIndex((agent) => agent.id === AGENT_ID);
  const next = managedAgent(launcher, managedEnv, index >= 0 ? agents[index] : undefined);
  if (index >= 0 && JSON.stringify(agents[index]) === JSON.stringify(next)) return false;

  const updated = index >= 0 ? agents.map((agent, i) => (i === index ? next : agent)) : [...agents, next];
  await bb.sdk.plugins.updateSettings({
    pluginId: ACP_PLUGIN_ID,
    values: { customAgents: `${JSON.stringify(updated, null, 2)}\n` },
  });
  bb.log.info(`Updated the ${DISPLAY_NAME} (${AGENT_ID}) agent entry`);
  return true;
}
