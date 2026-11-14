import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { isPlanApprovalRequest, planApprovalQuestion, planApprovalResult, shownOptions } from "../bin/plan-approval.mjs";

const OPTIONS = [
  { optionId: "exit-plan-clear-auto", name: "Yes, clear context and use auto mode", kind: "allow_always" },
  { optionId: "exit-plan-auto", name: "Yes, and use auto mode", kind: "allow_always" },
  { optionId: "exit-plan-bypass", name: "Yes, and bypass permissions", kind: "allow_always" },
  { optionId: "exit-plan-default", name: "Yes, manually approve edits", kind: "allow_once" },
  { optionId: "reject", name: "No, keep planning", kind: "reject_once" },
];
const REQUEST = {
  jsonrpc: "2.0",
  id: 5,
  method: "session/request_permission",
  params: { sessionId: "s1", toolCall: { toolCallId: "t1", rawInput: { plan: "# Plan\n\n1. Do it" } }, options: OPTIONS },
};

test("recognizes only the plan approval request", () => {
  assert.equal(isPlanApprovalRequest(REQUEST), true);
  const other = { ...REQUEST, params: { ...REQUEST.params, options: [{ optionId: "allow-once", name: "Yes", kind: "allow_once" }] } };
  assert.equal(isPlanApprovalRequest(other), false);
  assert.equal(isPlanApprovalRequest({ method: "session/update", params: {} }), false);
});

test("shows at most 4 options, dropping bypass first and keeping keep-planning", () => {
  assert.deepEqual(shownOptions(OPTIONS).map((o) => o.optionId), ["exit-plan-clear-auto", "exit-plan-auto", "exit-plan-default", "reject"]);
});

test("asks a single-choice question with the plan", () => {
  const q = planApprovalQuestion(REQUEST, "q1");
  assert.equal(q.method, "elicitation/create");
  assert.equal(q.id, "q1");
  assert.equal(q.params.mode, "form");
  assert.match(q.params.message, /^# Plan\n\n1\. Do it\n\nReady to code\?$/);
  assert.deepEqual(q.params.requestedSchema.required, ["decision"]);
  assert.equal(q.params.requestedSchema.properties.decision.oneOf.at(-1).title, "No, keep planning");
});

test("maps the answer back to the permission result", () => {
  const accept = { result: { action: "accept", content: { decision: "exit-plan-auto" } } };
  assert.deepEqual(planApprovalResult(accept, OPTIONS), { outcome: { outcome: "selected", optionId: "exit-plan-auto" } });
  assert.deepEqual(planApprovalResult({ result: { action: "decline" } }, OPTIONS), { outcome: { outcome: "selected", optionId: "reject" } });
  assert.deepEqual(planApprovalResult({ result: { action: "cancel" } }, OPTIONS), { outcome: { outcome: "cancelled" } });
  assert.deepEqual(planApprovalResult({ error: { code: -32602 } }, OPTIONS), { outcome: { outcome: "cancelled" } });
  const unknown = { result: { action: "accept", content: { decision: "nope" } } };
  assert.deepEqual(planApprovalResult(unknown, OPTIONS), { outcome: { outcome: "cancelled" } });
});

test("proxy: holds the request, asks bb, answers the agent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "plan-approval-"));
  const agent = join(dir, "agent.mjs");
  // fake ACP agent: sends the plan approval request, echoes what it gets back on stderr-free stdout as a notification
  writeFileSync(
    agent,
    `import { createInterface } from "node:readline";
process.stdout.write(${JSON.stringify(JSON.stringify(REQUEST))} + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "test/received", params: JSON.parse(line) }) + "\\n");
  process.exit(0);
});
`,
  );
  const proxy = spawn(process.execPath, [join(import.meta.dirname, "..", "bin", "claude-bedrock-acp-proxy.mjs"), process.execPath, agent], {
    env: { ...process.env, XDG_STATE_HOME: dir },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const lines = createInterface({ input: proxy.stdout });
  const received = [];
  const done = new Promise((resolve) => lines.on("line", (line) => {
    const msg = JSON.parse(line);
    received.push(msg);
    if (msg.method === "elicitation/create") {
      proxy.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { action: "accept", content: { decision: "exit-plan-default" } } }) + "\n");
    }
    if (msg.method === "test/received") resolve();
  }));
  await done;
  proxy.kill();
  assert.equal(received.some((m) => m.method === "session/request_permission"), false, "permission request must not reach bb");
  assert.equal(received[0].method, "elicitation/create");
  assert.deepEqual(received.at(-1).params, { jsonrpc: "2.0", id: 5, result: { outcome: { outcome: "selected", optionId: "exit-plan-default" } } });
});
