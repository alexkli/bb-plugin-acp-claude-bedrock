import assert from "node:assert/strict";
import { test } from "node:test";
import { AGENT_ID, formatCustomAgents, isOurEntry, parseCustomAgents, userEnv, withoutLegacyEntry } from "../legacy-entry.ts";

test("the old entry is claude-bedrock, which provider-acp registered as acp-claude-bedrock", () => {
  assert.equal(AGENT_ID, "claude-bedrock");
});

test("withoutLegacyEntry removes only the entry 0.1 added (our id and launcher); null when there is none", () => {
  const other = { id: "gh-copilot", command: "copilot" };
  const ours = { id: "claude-bedrock", command: "/Users/me/.bb/plugins/x/bin/claude-bedrock-acp" };
  const usersOwn = { id: "claude-bedrock", command: "/usr/local/bin/my-claude" };
  assert.equal(isOurEntry(ours), true);
  assert.equal(isOurEntry(usersOwn), false);
  assert.deepEqual(withoutLegacyEntry([other, ours]), [other]);
  assert.equal(withoutLegacyEntry([other]), null);
  assert.equal(withoutLegacyEntry([other, usersOwn]), null);
});

test("formatCustomAgents keeps the setting's indentation and trailing newline", () => {
  const agents = [{ id: "a", args: ["x"] }];
  assert.equal(formatCustomAgents(agents, '[{"id":"a"},{"id":"b"}]'), '[{"id":"a","args":["x"]}]');
  assert.equal(formatCustomAgents(agents, '[\n    {"id": "a"}\n]\n'), '[\n    {\n        "id": "a",\n        "args": [\n            "x"\n        ]\n    }\n]\n');
  assert.equal(formatCustomAgents(agents, '[\n\t{"id": "a"}\n]'), '[\n\t{\n\t\t"id": "a",\n\t\t"args": [\n\t\t\t"x"\n\t\t]\n\t}\n]');
  assert.equal(formatCustomAgents([], "[]"), "");
});

test("userEnv keeps only the variables the user added to the old entry", () => {
  const entry = { id: "claude-bedrock", env: { AWS_REGION: "us-west-2", CLAUDE_BEDROCK_PRICE_FACTOR: "1", ANTHROPIC_MODEL: "x", CLAUDE_BEDROCK_ASK_PLAN_APPROVAL: "0" } };
  assert.deepEqual(userEnv(entry), { ANTHROPIC_MODEL: "x", CLAUDE_BEDROCK_ASK_PLAN_APPROVAL: "0" });
  assert.deepEqual(userEnv(undefined), {});
  assert.deepEqual(userEnv({ id: "claude-bedrock" }), {});
});

test("parseCustomAgents refuses to overwrite a setting that is not a list", () => {
  assert.deepEqual(parseCustomAgents(undefined), []);
  assert.deepEqual(parseCustomAgents("  "), []);
  assert.deepEqual(parseCustomAgents('[{"id":"a"}]'), [{ id: "a" }]);
  assert.throws(() => parseCustomAgents('{"id":"a"}'), /refusing to overwrite/);
  assert.throws(() => parseCustomAgents(42), /must be a string/);
});
