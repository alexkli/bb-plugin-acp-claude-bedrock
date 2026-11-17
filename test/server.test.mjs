import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";

const OTHER = { id: "gh-copilot", displayName: "GitHub Copilot", command: "copilot", args: ["--acp"] };

/**
 * Loads the plugin against a fake bb whose ACP agents plugin stores
 * customAgents in memory. The API key setting keeps status() away from the
 * real keychain; the data dir is a temp folder.
 */
async function load({ customAgents = JSON.stringify([OTHER]), settings = {}, registered = true, acpDown = false } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "bedrock-server-"));
  let stored = customAgents;
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
      providers: { list: async () => (registered ? [{ id: "acp-claude-bedrock" }] : []) },
      system: { config: async () => ({ dataDir }) },
    },
  });
  await plugin(bb);
  const agents = () => (stored === "" ? [] : JSON.parse(stored));
  const ours = () => agents().find((agent) => agent.id === "claude-bedrock");
  return { harness, dataDir, agents, ours };
}

const cli = async (harness, ...argv) => {
  const { exitCode, stdout, stderr } = await harness.runCli(argv);
  return { exitCode, stdout, stderr };
};

test("the provision service adds the entry next to other agents; the API key only as a 0600 file", async () => {
  const { harness, dataDir, agents, ours } = await load();
  await harness.runService("provision").done;
  assert.deepEqual(harness.needsConfigurationMessages, []);
  assert.deepEqual(agents()[0], OTHER);
  const entry = ours();
  assert.match(entry.command, /\/bin\/claude-bedrock-acp$/);
  assert.deepEqual(entry.permissionCli, { full: ["--bb-permission-mode=full"], workspaceWrite: ["--bb-permission-mode=accept-edits"] });
  assert.equal(entry.supportsManualCompaction, true);
  const keyFile = join(dataDir, "plugins", "acp-claude-bedrock", "host-data", "bedrock-api-key");
  assert.deepEqual(entry.env, { AWS_REGION: "us-west-2", CLAUDE_BEDROCK_PRICE_FACTOR: "1", CLAUDE_BEDROCK_KEY_FILE: keyFile });
  assert.equal(readFileSync(keyFile, "utf8"), "test-key\n");
  assert.equal(statSync(keyFile).mode & 0o777, 0o600);
  assert.doesNotMatch(JSON.stringify(agents()), /test-key/);
});

test("turning the sandbox off sets CLAUDE_BEDROCK_SANDBOX=0", async () => {
  const { harness, ours } = await load({ settings: { sandbox: false } });
  await harness.runService("provision").done;
  assert.equal(ours().env.CLAUDE_BEDROCK_SANDBOX, "0");
});

test("status passes once registered; an outdated entry fails it until repair", async () => {
  const stale = { id: "claude-bedrock", displayName: "Claude Code (Bedrock ACP)", command: "/old/claude-bedrock-acp", args: [], env: {} };
  const { harness, ours } = await load({ customAgents: JSON.stringify([OTHER, stale]) });

  const before = await cli(harness, "status");
  assert.equal(before.exitCode, 1);
  assert.match(before.stdout, /ACP customAgents entry "claude-bedrock": OUTDATED \(run: bb acp-claude-bedrock repair\)/);

  const repaired = await cli(harness, "repair");
  assert.deepEqual(repaired, { exitCode: 0, stdout: "acp-claude-bedrock: repaired\n", stderr: "" });
  assert.match(ours().command, /\/bin\/claude-bedrock-acp$/);

  const after = await cli(harness, "status");
  assert.equal(after.exitCode, 0, after.stdout);
  assert.match(after.stdout, /^Launcher: .*\/bin\/claude-bedrock-acp\n/);
  assert.match(after.stdout, /ACP adapter: bundled @agentclientprotocol\/claude-agent-acp 0\.107\.3\n/);
  assert.match(after.stdout, /ACP customAgents entry "claude-bedrock": current\n/);
  assert.match(after.stdout, /bb provider acp-claude-bedrock: registered\n/);
  assert.match(after.stdout, /Credentials: API key setting\nRegion: us-west-2\nBash sandbox in Accept Edits: on\n$/);
  assert.doesNotMatch(after.stdout, /test-key/);
  assert.deepEqual(await cli(harness, "repair"), { exitCode: 0, stdout: "acp-claude-bedrock: already up to date\n", stderr: "" });
});

test("status fails when bb has not registered the provider", async () => {
  const { harness } = await load({ registered: false });
  await harness.runService("provision").done;
  const { exitCode, stdout } = await cli(harness, "status");
  assert.equal(exitCode, 1);
  assert.match(stdout, /bb provider acp-claude-bedrock: NOT registered/);
});

test("unregister removes only this plugin's entry", async () => {
  const { harness, agents } = await load();
  await harness.runService("provision").done;
  assert.equal(agents().length, 2);
  const first = await cli(harness, "unregister");
  assert.equal(first.exitCode, 0);
  assert.match(first.stdout, /unregistered/);
  assert.deepEqual(agents(), [OTHER]);
  assert.deepEqual(await cli(harness, "unregister"), { exitCode: 0, stdout: "acp-claude-bedrock: not registered\n", stderr: "" });
});

test("when the ACP agents plugin's settings can't be read, bb shows the plugin as needing configuration", async () => {
  const { harness } = await load({ acpDown: true });
  await harness.runService("provision").done;
  assert.equal(harness.needsConfigurationMessages.length, 1);
  assert.match(harness.needsConfigurationMessages[0], /Could not register the Claude Code \(Bedrock ACP\) agent: .*not available.*bb acp-claude-bedrock repair/);
  const status = await cli(harness, "status");
  assert.equal(status.exitCode, 1);
  assert.match(status.stdout, /ACP customAgents entry: unknown/);
});

test("an unknown subcommand names the valid ones", async () => {
  const { harness } = await load();
  const { exitCode, stderr } = await cli(harness, "nope");
  assert.equal(exitCode, 2);
  assert.match(stderr, /status \| repair \| unregister/);
});
