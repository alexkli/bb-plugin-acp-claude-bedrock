import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";

const OTHER = { id: "gh-copilot", displayName: "GitHub Copilot", command: "copilot", args: ["--acp"] };
const OLD_ENTRY = {
  id: "claude-bedrock",
  displayName: "Claude Code (Bedrock ACP)",
  command: "/old/bin/claude-bedrock-acp",
  args: [],
  env: { AWS_REGION: "us-west-2", CLAUDE_BEDROCK_PRICE_FACTOR: "1", CLAUDE_BEDROCK_ASK_PLAN_APPROVAL: "0" },
};

/**
 * Loads the plugin against a fake bb whose ACP agents plugin stores
 * customAgents in memory and whose provider list shows what this plugin
 * registered. The API key setting keeps status() away from the real keychain;
 * like bb, the fake keeps it in secrets/apiKey (unless secretFile is false).
 */
async function load({ customAgents = JSON.stringify([OTHER]), settings = {}, acpDown = false, secretFile = true, oldKeyFile = false } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "bedrock-server-"));
  const pluginData = join(dataDir, "plugins", "acp-claude-bedrock");
  if (secretFile) {
    mkdirSync(join(pluginData, "secrets"), { recursive: true });
    writeFileSync(join(pluginData, "secrets", "apiKey"), "test-key", { mode: 0o600 });
  }
  if (oldKeyFile) {
    mkdirSync(join(pluginData, "host-data"), { recursive: true });
    writeFileSync(join(pluginData, "host-data", "bedrock-api-key"), "old-key\n", { mode: 0o600 });
  }
  let stored = customAgents;
  let harnessRef;
  const { bb, harness } = createFakePluginHost({
    pluginId: "acp-claude-bedrock",
    settings: { apiKey: "test-key", region: "us-west-2", ...settings },
    sdk: {
      plugins: {
        getSettings: async () => {
          if (acpDown) throw new Error("HTTP 404: unknown plugin");
          return { pluginId: "provider-acp", values: { customAgents: stored } };
        },
        updateSettings: async ({ values }) => {
          stored = values.customAgents;
          return { pluginId: "provider-acp", values };
        },
      },
      providers: {
        list: async () =>
          harnessRef.registrations.providerRegistrations.map((p) => ({ id: p.id, pluginId: "acp-claude-bedrock", capabilities: { supportsFork: p.capabilities.fork !== "none" } })),
      },
      system: { config: async () => ({ dataDir }) },
    },
  });
  harnessRef = harness;
  await plugin(bb);
  const hostData = join(pluginData, "host-data");
  const secret = join(pluginData, "secrets", "apiKey");
  const agents = () => (stored === "" ? [] : JSON.parse(stored));
  return { bb, harness, hostData, secret, agents, raw: () => stored };
}

const cli = async (harness, ...argv) => {
  const { exitCode, stdout, stderr } = await harness.runCli(argv);
  return { exitCode, stdout, stderr };
};

test("the provider service registers acp-claude-bedrock with forks and writes the agent's settings, naming bb's own secret file for the key", async () => {
  const { harness, hostData, secret, agents } = await load({ oldKeyFile: true });
  await harness.runService("provider").done;
  assert.deepEqual(harness.needsConfigurationMessages, []);
  assert.deepEqual(harness.registrations.providerRegistrations.map((p) => [p.id, p.capabilities.fork]), [["acp-claude-bedrock", "tip"]]);
  const spec = harness.registrations.providerRegistrations[0].experimental_bridgeOptions.acpLaunchSpec;
  assert.match(spec.command, /\/bin\/claude-bedrock-acp$/);
  assert.deepEqual(spec.env, { CLAUDE_BEDROCK_ENV_FILE: join(hostData, "agent.env") });
  const env = readFileSync(join(hostData, "agent.env"), "utf8");
  assert.match(env, /^export AWS_REGION='us-west-2'$/m);
  assert.match(env, new RegExp(`^export CLAUDE_BEDROCK_KEY_FILE='${secret}'$`, "m"));
  assert.doesNotMatch(env, /test-key/);
  assert.equal(statSync(join(hostData, "agent.env")).mode & 0o777, 0o600);
  assert.equal(existsSync(join(hostData, "bedrock-api-key")), false, "the old key copy is removed");
  assert.deepEqual(agents(), [OTHER], "no customAgents entry any more");
});

test("handover: the old entry is removed, other agents stay, and the user's own variables move to Extra environment variables", async () => {
  const { harness, hostData, agents } = await load({ customAgents: JSON.stringify([OTHER, OLD_ENTRY]) });
  await harness.runService("provider").done;
  assert.deepEqual(agents(), [OTHER]);
  assert.match(readFileSync(join(hostData, "agent.env"), "utf8"), /^export CLAUDE_BEDROCK_ASK_PLAN_APPROVAL='0'$/m);
  assert.equal(harness.registrations.providerRegistrations.length, 1);
});

test("turning the sandbox off writes CLAUDE_BEDROCK_SANDBOX=0 to the agent's settings", async () => {
  const { harness, hostData } = await load({ settings: { sandbox: false } });
  await harness.runService("provider").done;
  assert.match(readFileSync(join(hostData, "agent.env"), "utf8"), /^export CLAUDE_BEDROCK_SANDBOX='0'$/m);
});

test("status: fails before registration and with a leftover entry, passes once set up; repair sets up", async () => {
  const { harness } = await load({ customAgents: JSON.stringify([OTHER, OLD_ENTRY]) });
  const before = await cli(harness, "status");
  assert.equal(before.exitCode, 1);
  assert.match(before.stdout, /bb provider acp-claude-bedrock: NOT registered \(run: bb acp-claude-bedrock repair\)/);
  assert.match(before.stdout, /Old provider-acp customAgents entry "claude-bedrock": LEFTOVER/);

  assert.deepEqual(await cli(harness, "repair"), { exitCode: 0, stdout: "acp-claude-bedrock: repaired\n", stderr: "" });
  const after = await cli(harness, "status");
  assert.equal(after.exitCode, 0, after.stdout);
  assert.match(after.stdout, /^Launcher: .*\/bin\/claude-bedrock-acp\n/);
  assert.match(after.stdout, /ACP adapter: bundled @agentclientprotocol\/claude-agent-acp 0\.107\.3\n/);
  assert.match(after.stdout, /bb provider acp-claude-bedrock: registered by this plugin, side chats on\n/);
  assert.doesNotMatch(after.stdout, /LEFTOVER/);
  assert.match(after.stdout, /Agent settings file: .*agent\.env\n/);
  assert.match(after.stdout, /Credentials: API key setting\nRegion: us-west-2\nBash sandbox in Accept Edits: on\n$/);
  assert.doesNotMatch(after.stdout, /test-key/);
  assert.deepEqual(await cli(harness, "repair"), { exitCode: 0, stdout: "acp-claude-bedrock: already up to date\n", stderr: "" });
});

test("without the ACP agents plugin there is nothing to hand over: the provider registers anyway", async () => {
  const { harness } = await load({ acpDown: true });
  await harness.runService("provider").done;
  assert.deepEqual(harness.needsConfigurationMessages, []);
  assert.equal(harness.registrations.providerRegistrations.length, 1);
  assert.equal((await cli(harness, "status")).exitCode, 0);
});

test("an unknown subcommand names the valid ones", async () => {
  const { harness } = await load();
  const { exitCode, stderr } = await cli(harness, "unregister");
  assert.equal(exitCode, 2);
  assert.match(stderr, /status \| repair/);
});

test("without bb's secret file for the API key, bb shows the plugin as needing configuration and status fails", async () => {
  const { harness, secret } = await load({ secretFile: false });
  await harness.runService("provider").done;
  assert.equal(harness.needsConfigurationMessages.length, 1);
  assert.match(harness.needsConfigurationMessages[0], /file for the API key setting is not at .*secrets\/apiKey/);
  const status = await cli(harness, "status");
  assert.equal(status.exitCode, 1);
  assert.ok(status.stdout.includes(`Credentials: API key setting (bb's secret file ${secret} MISSING`), status.stdout);
});

test("the handover keeps the customAgents formatting, and leaves a claude-bedrock agent this plugin didn't add alone", async () => {
  const compact = await load({ customAgents: JSON.stringify([OTHER, OLD_ENTRY]) });
  await compact.harness.runService("provider").done;
  assert.equal(compact.raw(), JSON.stringify([OTHER]));

  const usersOwn = { id: "claude-bedrock", command: "/usr/local/bin/my-claude", env: { FOO: "1" } };
  const text = `${JSON.stringify([OTHER, usersOwn], null, 4)}\n`;
  const kept = await load({ customAgents: text });
  await kept.harness.runService("provider").done;
  assert.equal(kept.raw(), text);
  const status = await cli(kept.harness, "status");
  assert.doesNotMatch(status.stdout, /LEFTOVER/);
});
