import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import {
  isPlanApprovalRequest,
  planApprovalQuestion,
  planApprovalResult,
  planFileFromUpdate,
  planLinkUpdate,
  shownOptions,
} from "../bin/plan-approval.mjs";

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

test("asks a short single-choice question that explains how to give feedback", () => {
  const q = planApprovalQuestion(REQUEST, "q1", "/home/u/.claude/plans/whimsical-marshmallow.md");
  assert.equal(q.method, "elicitation/create");
  assert.equal(q.id, "q1");
  assert.equal(q.params.mode, "form");
  assert.match(q.params.message, /^Claude has finished planning\. Open the plan from the link above\. /);
  assert.match(q.params.message, /pick "No, keep planning" and send your feedback as a message\.$/);
  assert.doesNotMatch(q.params.message, /Ready to code/, "bb adds the field title; don't repeat it");
  const field = q.params.requestedSchema.properties.decision;
  assert.equal(field.title, "Ready to code?");
  assert.deepEqual(q.params.requestedSchema.required, ["decision"]);
  assert.deepEqual(field.oneOf.at(-1), { const: "reject", title: "No, keep planning (then send your feedback)" });
  assert.equal(field.oneOf[0].title, "Yes, clear context and use auto mode");
  assert.match(planApprovalQuestion(REQUEST, "q2").params.message, /ExitPlanMode step/);
});

test("links the plan file in Claude's message", () => {
  assert.deepEqual(planLinkUpdate("s1", "/h/.claude/plans/my plan.md").params, {
    sessionId: "s1",
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "\n\n**Plan ready for review:** [my plan.md](</h/.claude/plans/my plan.md>)\n" },
    },
  });
});

test("finds the plan file Claude writes", () => {
  const update = (u) => ({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: u } });
  assert.deepEqual(
    planFileFromUpdate(update({ sessionUpdate: "tool_call", locations: [{ path: "/h/.claude/plans/a-b-c.md" }] })),
    ["s1", "/h/.claude/plans/a-b-c.md"],
  );
  assert.deepEqual(
    planFileFromUpdate(update({ sessionUpdate: "tool_call_update", rawInput: { file_path: "/h/.claude/plans/x.md" } })),
    ["s1", "/h/.claude/plans/x.md"],
  );
  assert.equal(planFileFromUpdate(update({ sessionUpdate: "tool_call", locations: [{ path: "/repo/README.md" }] })), null);
  assert.equal(planFileFromUpdate(update({ sessionUpdate: "agent_message_chunk" })), null);
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

/** Runs the proxy around a fake agent that sends `lines`, answers the question, and returns what bb saw. */
async function runProxy(lines) {
  const dir = mkdtempSync(join(tmpdir(), "plan-approval-"));
  const agent = join(dir, "agent.mjs");
  writeFileSync(
    agent,
    `import { createInterface } from "node:readline";
for (const line of ${JSON.stringify(lines.map((l) => JSON.stringify(l)))}) process.stdout.write(line + "\\n");
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
  const received = [];
  await new Promise((resolve) =>
    createInterface({ input: proxy.stdout }).on("line", (line) => {
      const msg = JSON.parse(line);
      received.push(msg);
      if (msg.method === "elicitation/create") {
        proxy.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { action: "accept", content: { decision: "exit-plan-default" } } }) + "\n");
      }
      if (msg.method === "test/received") resolve();
    }),
  );
  proxy.kill();
  return { dir, received };
}

test("proxy: holds the request, links Claude's plan file, asks bb, answers the agent", async () => {
  const write = {
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId: "s1", update: { sessionUpdate: "tool_call", toolCallId: "w1", locations: [{ path: "/h/.claude/plans/p.md" }] } },
  };
  const { received } = await runProxy([write, REQUEST]);
  assert.equal(received.some((m) => m.method === "session/request_permission"), false, "permission request must not reach bb");
  assert.deepEqual(received.map((m) => m.method), ["session/update", "session/update", "elicitation/create", "test/received"], "order kept");
  assert.equal(received[1].params.update.content.text, "\n\n**Plan ready for review:** [p.md](/h/.claude/plans/p.md)\n");
  assert.deepEqual(received.at(-1).params, { jsonrpc: "2.0", id: 5, result: { outcome: { outcome: "selected", optionId: "exit-plan-default" } } });
});

test("proxy: without a plan file, writes the plan text to one and links it", async () => {
  const { dir, received } = await runProxy([REQUEST]);
  const plans = readdirSync(join(dir, "claude-bedrock", "plans"));
  assert.equal(plans.length, 1);
  const path = join(dir, "claude-bedrock", "plans", plans[0]);
  assert.equal(readFileSync(path, "utf8"), "# Plan\n\n1. Do it\n");
  assert.equal(received[0].params.update.content.text, `\n\n**Plan ready for review:** [${plans[0]}](${path})\n`);
  assert.equal(received[1].method, "elicitation/create");
});
