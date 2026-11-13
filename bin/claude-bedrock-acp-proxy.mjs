#!/usr/bin/env node
// ACP stdio proxy between bb and @agentclientprotocol/claude-agent-acp, used by
// claude-bedrock-acp. In agent -> bb messages it:
//
// 1. Drops the session config options listed in CLAUDE_BEDROCK_ACP_HIDE_OPTIONS
//    (comma-separated ids, default "agent"): with many subagents, the subagent
//    option squeezes bb's model picker list on narrow screens.
// 2. Scales usage_update cost by CLAUDE_BEDROCK_PRICE_FACTOR (default 1):
//    Claude Code estimates cost at public list prices; set this to your
//    negotiated Bedrock rate (e.g. 0.8 for 20% below list).
// 3. Appends each session's running list-price cost to the Bedrock cost ledger
//    ($XDG_STATE_HOME/claude-bedrock/cost.jsonl, default
//    ~/.local/state/claude-bedrock/cost.jsonl; one JSON object per line:
//    t = epoch ms, src, key = one session in one process, usd = cumulative
//    list-price USD). The plugin's usage entry sums it.
//
// Usage: claude-bedrock-acp-proxy.mjs <command> [args...]
import { spawn } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const PRICE_FACTOR = Number(process.env.CLAUDE_BEDROCK_PRICE_FACTOR ?? "1") || 1;
const HIDDEN_OPTIONS = new Set(
  (process.env.CLAUDE_BEDROCK_ACP_HIDE_OPTIONS ?? "agent").split(",").filter(Boolean),
);

const LEDGER_DIR = join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "claude-bedrock");
const RUN = `${process.pid}-${Date.now()}`;
// serialised appends; ledger failures must never disturb the ACP stream
let ledger = mkdir(LEDGER_DIR, { recursive: true }).catch(() => {});
const record = (sessionId, usd) => {
  const line = JSON.stringify({ t: Date.now(), src: "bb", key: `bb:${RUN}:${sessionId}`, usd }) + "\n";
  ledger = ledger.then(() => appendFile(join(LEDGER_DIR, "cost.jsonl"), line)).catch(() => {});
};

const [cmd, ...args] = process.argv.slice(2);
const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "inherit"] });

process.stdin.pipe(child.stdin);
child.stdin.on("error", () => {});

const filterOptions = (obj) => {
  if (obj && Array.isArray(obj.configOptions)) {
    obj.configOptions = obj.configOptions.filter((o) => !HIDDEN_OPTIONS.has(o?.id));
  }
};

const rewrite = (msg) => {
  filterOptions(msg.result);
  const update = msg.method === "session/update" ? msg.params?.update : undefined;
  if (update) {
    filterOptions(update);
    if (update.sessionUpdate === "usage_update" && typeof update.cost?.amount === "number") {
      record(msg.params.sessionId, update.cost.amount);
      update.cost.amount *= PRICE_FACTOR;
    }
  }
  return msg;
};

const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
rl.on("line", (line) => {
  let out = line;
  try {
    out = JSON.stringify(rewrite(JSON.parse(line)));
  } catch {
    // not JSON: pass through untouched
  }
  process.stdout.write(out + "\n");
});

for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(sig, () => child.kill(sig));
}
// exit only once the child is gone and all of its output has been forwarded
let exitCode = null;
let drained = false;
const maybeExit = () => {
  if (exitCode !== null && drained) {
    ledger.finally(() => process.stdout.write("", () => process.exit(exitCode)));
  }
};
rl.on("close", () => { drained = true; maybeExit(); });
child.on("exit", (code, signal) => { exitCode = code ?? (signal ? 1 : 0); maybeExit(); });
