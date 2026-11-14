// Plan approval for claude-bedrock-acp-proxy.mjs.
//
// When Claude finishes planning in plan mode, it calls ExitPlanMode and the
// ACP adapter asks the client for permission ("Ready to code?") with options
// such as "Yes, and use auto mode", "Yes, manually approve edits" and "No,
// keep planning". bb's ACP bridge answers every permission request itself in
// Full Access (it picks the first allow option), so the plan would never wait
// for the user. The proxy holds that request and asks bb an elicitation
// question instead, which bb always shows, then answers the adapter with the
// option the user picked.

/** The adapter's option ids for this request all start with this (claude-agent-acp). */
const EXIT_PLAN_OPTION_PREFIX = "exit-plan-";
/** bb shows at most this many options per question. */
const MAX_OPTIONS = 4;
/** Options to leave out first when there are more than bb can show. */
const DROP_ORDER = ["exit-plan-bypass", "exit-plan-clear-bypass", "exit-plan-clear-accept-edits", "exit-plan-clear-auto"];
/** Longest plan text shown in the question; the full plan is in the thread. */
const MAX_PLAN_CHARS = 6000;

/** Whether an agent -> client message is the permission request that ends plan mode. */
export function isPlanApprovalRequest(msg) {
  return (
    msg !== null &&
    typeof msg === "object" &&
    msg.method === "session/request_permission" &&
    msg.id !== undefined &&
    Array.isArray(msg.params?.options) &&
    msg.params.options.some((o) => typeof o?.optionId === "string" && o.optionId.startsWith(EXIT_PLAN_OPTION_PREFIX))
  );
}

/** The request's options, cut to what bb can show; the reject option always stays. */
export function shownOptions(options) {
  const shown = options.filter((o) => typeof o?.optionId === "string" && typeof o?.name === "string");
  for (const id of DROP_ORDER) {
    if (shown.length <= MAX_OPTIONS) break;
    const index = shown.findIndex((o) => o.optionId === id);
    if (index >= 0) shown.splice(index, 1);
  }
  while (shown.length > MAX_OPTIONS) {
    const index = shown.findIndex((o) => !String(o.kind).startsWith("reject"));
    shown.splice(index, 1);
  }
  return shown;
}

/** The elicitation/create request that asks the user about a plan approval request. */
export function planApprovalQuestion(msg, questionId) {
  const plan = msg.params?.toolCall?.rawInput?.plan;
  const planText =
    typeof plan === "string" && plan.trim() !== ""
      ? plan.trim().length > MAX_PLAN_CHARS
        ? `${plan.trim().slice(0, MAX_PLAN_CHARS)}\n\n[… plan truncated; the full plan is in the thread]`
        : plan.trim()
      : null;
  const message = planText === null ? "Claude has finished planning. Ready to code?" : `${planText}\n\nReady to code?`;
  return {
    jsonrpc: "2.0",
    id: questionId,
    method: "elicitation/create",
    params: {
      ...(msg.params?.sessionId ? { sessionId: msg.params.sessionId } : {}),
      mode: "form",
      message,
      requestedSchema: {
        type: "object",
        properties: {
          decision: {
            type: "string",
            title: "Ready to code?",
            oneOf: shownOptions(msg.params.options).map((o) => ({ const: o.optionId, title: o.name })),
          },
        },
        required: ["decision"],
      },
    },
  };
}

/**
 * The result for the held permission request, from bb's answer to the
 * question: the picked option; "No, keep planning" when the user declined;
 * cancelled when the question was dismissed or failed (the turn stops, and
 * Claude stays in plan mode).
 */
export function planApprovalResult(answer, options) {
  const ids = new Set(options.map((o) => o?.optionId));
  const reject = options.find((o) => String(o?.kind).startsWith("reject"))?.optionId;
  const result = answer?.result;
  if (result?.action === "accept" && ids.has(result.content?.decision)) {
    return { outcome: { outcome: "selected", optionId: result.content.decision } };
  }
  if (result?.action === "decline" && reject !== undefined) {
    return { outcome: { outcome: "selected", optionId: reject } };
  }
  return { outcome: { outcome: "cancelled" } };
}
