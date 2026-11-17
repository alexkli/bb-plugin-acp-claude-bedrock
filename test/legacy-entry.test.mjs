import assert from "node:assert/strict";
import { test } from "node:test";
import { AGENT_ID, parseCustomAgents, userEnv, withoutLegacyEntry } from "../legacy-entry.ts";

test("the old entry is claude-bedrock, which provider-acp registered as acp-claude-bedrock", () => {
  assert.equal(AGENT_ID, "claude-bedrock");
});

test("withoutLegacyEntry removes only the old entry; null when there is none", () => {
  const other = { id: "gh-copilot", command: "copilot" };
  assert.deepEqual(withoutLegacyEntry([other, { id: "claude-bedrock", command: "/x" }]), [other]);
  assert.equal(withoutLegacyEntry([other]), null);
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
