import assert from "node:assert/strict";
import { test } from "node:test";
import { ACP_PLUGIN_ID, AGENT_ID, DISPLAY_NAME, PERMISSION_CLI, managedAgent, provisionAgent } from "../agent-entry.ts";

const LAUNCHER = "/plugins/acp-claude-bedrock/bin/claude-bedrock-acp";

test("the agent is acp-claude-bedrock, apart from the Claude Bedrock provider plugin's claude-bedrock", () => {
  assert.equal(ACP_PLUGIN_ID, "provider-acp");
  assert.equal(AGENT_ID, "claude-bedrock");
  assert.equal(DISPLAY_NAME, "Claude Code (Bedrock ACP)");
});

test("a new entry runs the launcher with the managed env, bb's permission modes and /compact", () => {
  assert.deepEqual(managedAgent(LAUNCHER, { AWS_REGION: "us-west-2", AWS_PROFILE: "", CLAUDE_BEDROCK_SANDBOX: undefined }), {
    nativeSkillRoots: { user: [".claude/skills"], project: [".claude/skills"] },
    id: "claude-bedrock",
    displayName: "Claude Code (Bedrock ACP)",
    command: LAUNCHER,
    args: [],
    env: { AWS_REGION: "us-west-2" },
    permissionCli: { full: ["--bb-permission-mode=full"], workspaceWrite: ["--bb-permission-mode=accept-edits"] },
    supportsManualCompaction: true,
  });
});

test("an update keeps the user's env and fields, drops managed variables that are now unset, and owns the launch fields", () => {
  const existing = {
    id: "claude-bedrock",
    displayName: "Renamed",
    command: "/old/launcher",
    args: ["--old"],
    env: { AWS_REGION: "eu-west-1", CLAUDE_AGENT_ACP: "/old/adapter", CLAUDE_BEDROCK_SANDBOX: "0", MY_VAR: "kept" },
    nativeSkillRoots: { user: ["custom"], project: [] },
    permissionCli: { full: ["--yolo"] },
    cwd: "/somewhere",
  };
  const next = managedAgent(LAUNCHER, { AWS_REGION: "us-east-1" }, existing);
  assert.deepEqual(next.env, { MY_VAR: "kept", AWS_REGION: "us-east-1" });
  assert.equal(next.command, LAUNCHER);
  assert.deepEqual(next.args, []);
  assert.equal(next.displayName, DISPLAY_NAME);
  assert.deepEqual(next.permissionCli, PERMISSION_CLI);
  assert.deepEqual(next.nativeSkillRoots, { user: ["custom"], project: [] }, "the user's skill roots stay");
  assert.equal(next.cwd, "/somewhere");
});

/** A bb API with just the ACP agents plugin's settings, recording updates. */
function fakeBb(customAgents) {
  const updates = [];
  const warnings = [];
  const bb = {
    sdk: {
      plugins: {
        getSettings: async ({ pluginId }) => {
          assert.equal(pluginId, "provider-acp");
          return { values: { customAgents } };
        },
        updateSettings: async (update) => {
          updates.push(update);
          customAgents = update.values.customAgents;
        },
      },
    },
    log: { info: () => {}, warn: (message) => warnings.push(message), error: () => {} },
  };
  return { bb, updates, warnings };
}

test("provisionAgent adds the entry next to other agents, then writes nothing while it is current", async () => {
  const other = { id: "gh-copilot", displayName: "GitHub Copilot", command: "copilot" };
  const { bb, updates } = fakeBb(JSON.stringify([other]));
  assert.equal(await provisionAgent(bb, LAUNCHER, { AWS_REGION: "us-west-2" }), true);
  const agents = JSON.parse(updates[0].values.customAgents);
  assert.deepEqual(agents[0], other);
  assert.equal(agents[1].id, "claude-bedrock");
  assert.equal(agents[1].supportsManualCompaction, true);
  assert.equal(await provisionAgent(bb, LAUNCHER, { AWS_REGION: "us-west-2" }), false);
  assert.equal(updates.length, 1);
});

test("provisionAgent refuses to overwrite a customAgents setting that is not a list", async () => {
  const { bb, updates, warnings } = fakeBb('{"not": "a list"}');
  await assert.rejects(provisionAgent(bb, LAUNCHER, {}), /not available/);
  assert.equal(updates.length, 0);
  assert.match(warnings[0], /must be a JSON array/);
});
