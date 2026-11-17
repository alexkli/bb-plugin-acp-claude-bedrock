import type { BbPluginApi } from "@get-bb/plugin-sdk";

// The agent entry earlier versions of this plugin kept in bb's ACP agents
// plugin (provider-acp), setting "customAgents": a JSON array of custom agents.
// provider-acp registered it as the provider "acp-" + id = acp-claude-bedrock.
// This plugin now registers that provider itself (provider.ts), and bb lets
// only one plugin hold a provider id, so the handover removes the entry first;
// provider-acp then drops the provider and this plugin registers it.
export const ACP_PLUGIN_ID = "provider-acp";
export const AGENT_ID = "claude-bedrock";

type JsonObject = Record<string, unknown>;
export type CustomAgent = JsonObject & { id?: unknown; env?: unknown };

const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function parseCustomAgents(value: unknown): CustomAgent[] {
  if (value === undefined || value === null || value === "") return [];
  if (typeof value !== "string") throw new Error(`${ACP_PLUGIN_ID} customAgents must be a string`);
  if (value.trim() === "") return [];
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) throw new Error(`${ACP_PLUGIN_ID} customAgents must be a JSON array; refusing to overwrite it`);
  return parsed as CustomAgent[];
}

/** Env variables earlier versions set from the plugin settings; any others in the entry were the user's. */
export const MANAGED_ENV = [
  "AWS_REGION",
  "AWS_PROFILE",
  "CLAUDE_AGENT_ACP",
  "CLAUDE_BEDROCK_PRICE_FACTOR",
  "CLAUDE_BEDROCK_KEY_FILE",
  "CLAUDE_BEDROCK_SANDBOX",
] as const;

/** The user's own variables in an old entry's env, to carry over to the Extra environment variables setting. */
export function userEnv(entry: CustomAgent | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  if (!isObject(entry?.env)) return env;
  for (const [name, value] of Object.entries(entry.env)) {
    if (!(MANAGED_ENV as readonly string[]).includes(name) && typeof value === "string") env[name] = value;
  }
  return env;
}

/** The customAgents list without our entry; null when it has none. */
export function withoutLegacyEntry(agents: CustomAgent[]): CustomAgent[] | null {
  const next = agents.filter((agent) => agent.id !== AGENT_ID);
  return next.length === agents.length ? null : next;
}

/**
 * Our old entry, `{ entry: undefined }` when there is none, or null when the
 * ACP agents plugin's settings can't be read (disabled or not installed:
 * then it holds no provider either).
 */
export async function readLegacyEntry(bb: BbPluginApi): Promise<{ entry: CustomAgent | undefined } | null> {
  try {
    const settings = await bb.sdk.plugins.getSettings({ pluginId: ACP_PLUGIN_ID });
    const agents = parseCustomAgents(settings.values.customAgents);
    return { entry: agents.find((agent) => agent.id === AGENT_ID) };
  } catch (error) {
    bb.log.warn(`Could not read ${ACP_PLUGIN_ID} customAgents: ${String(error)}`);
    return null;
  }
}

/** Removes our old entry, leaving other agents alone; true when there was one. */
export async function removeLegacyEntry(bb: BbPluginApi): Promise<boolean> {
  const settings = await bb.sdk.plugins.getSettings({ pluginId: ACP_PLUGIN_ID });
  const updated = withoutLegacyEntry(parseCustomAgents(settings.values.customAgents));
  if (updated === null) return false;
  await bb.sdk.plugins.updateSettings({
    pluginId: ACP_PLUGIN_ID,
    values: { customAgents: updated.length === 0 ? "" : `${JSON.stringify(updated, null, 2)}\n` },
  });
  bb.log.info(`Removed the old ${ACP_PLUGIN_ID} customAgents entry "${AGENT_ID}"`);
  return true;
}
