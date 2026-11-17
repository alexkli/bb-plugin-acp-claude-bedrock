import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";

const PLUGIN = join(import.meta.dirname, "..");

/**
 * A fake ACP adapter: reports its argv and environment, sends `lines`, then
 * echoes every bb -> agent line back as test/received and exits when its stdin
 * closes.
 */
function writeFakeAdapter(path, lines = []) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `import { createInterface } from "node:readline";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const env = process.env;
send({ jsonrpc: "2.0", method: "test/started", params: {
  argv: process.argv.slice(2),
  useBedrock: env.CLAUDE_CODE_USE_BEDROCK ?? null,
  region: env.AWS_REGION ?? null,
  token: env.AWS_BEARER_TOKEN_BEDROCK ?? null,
} });
for (const line of ${JSON.stringify(lines.map((l) => JSON.stringify(l)))}) process.stdout.write(line + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => send({ jsonrpc: "2.0", method: "test/received", params: JSON.parse(line) }));
`,
  );
}

/** Environment without anything of the developer's that the launcher or proxy reads. */
function cleanEnv(dir, extra = {}) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^(AWS_|CLAUDE_|ANTHROPIC_|BB_)/.test(name)) delete env[name];
  }
  return {
    ...env,
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: dir,
    XDG_STATE_HOME: join(dir, "state"),
    CLAUDE_BEDROCK_KEYCHAIN_SERVICE: "bb-plugin-acp-claude-bedrock-test-no-such-item",
    ...extra,
  };
}

/** Runs `command` speaking ACP: sends `toAgent` once the agent started, collects agent -> bb messages until `expected` arrived. */
async function run(command, args, env, toAgent, expected) {
  const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const received = [];
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out; got ${JSON.stringify(received)}; stderr ${stderr}`)), 10_000);
    createInterface({ input: child.stdout }).on("line", (line) => {
      received.push(JSON.parse(line));
      if (received.at(-1).method === "test/started") for (const m of toAgent) child.stdin.write(JSON.stringify(m) + "\n");
      if (received.length >= expected) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on("exit", () => setTimeout(() => reject(new Error(`exited early; got ${JSON.stringify(received)}; stderr ${stderr}`)), 200));
  });
  child.stdin.end();
  await new Promise((r) => child.on("exit", r));
  return received;
}

const SESSION_NEW = { jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: "/w", mcpServers: [], additionalDirectories: ["/storage"] } };
const PROMPT = { jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: "s1", prompt: [{ type: "text", text: "hi" }] } };

async function runProxy(permissionArgs, { env = {}, lines = [], toAgent = [SESSION_NEW, PROMPT] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "bedrock-proxy-"));
  const adapter = join(dir, "adapter.mjs");
  writeFakeAdapter(adapter, lines);
  const received = await run(
    process.execPath,
    [join(PLUGIN, "bin", "claude-bedrock-acp-proxy.mjs"), process.execPath, adapter, ...permissionArgs],
    cleanEnv(dir, env),
    toAgent,
    1 + lines.length + toAgent.length,
  );
  return { dir, received };
}

const sandboxOf = (received) => received.find((m) => m.params?.method === "session/new").params.params._meta?.claudeCode?.options?.sandbox;

test("proxy: Accept Edits runs Bash in the sandbox, and bb's argument never reaches the adapter", async () => {
  const { received } = await runProxy(["--bb-permission-mode=accept-edits"]);
  assert.deepEqual(received[0].params.argv, []);
  assert.deepEqual(sandboxOf(received), {
    enabled: true,
    failIfUnavailable: false,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: true,
    network: { allowLocalBinding: true },
    filesystem: { allowWrite: ["/storage"] },
  });
  const prompt = received.find((m) => m.params?.method === "session/prompt").params;
  assert.deepEqual(prompt, PROMPT, "other requests pass unchanged");
});

test("proxy: Full Access, an unknown mode and the opt-out get no sandbox", async () => {
  for (const [args, env] of [[["--bb-permission-mode=full"], {}], [[], {}], [["--bb-permission-mode=accept-edits"], { CLAUDE_BEDROCK_SANDBOX: "0" }]]) {
    const { received } = await runProxy(args, { env });
    assert.equal(sandboxOf(received), undefined, JSON.stringify({ args, env }));
    assert.deepEqual(received.find((m) => m.params?.method === "session/new").params, SESSION_NEW);
  }
});

test("proxy: hides the subagent option, scales the cost and records list-price spend in the ledger", async () => {
  const lines = [
    { jsonrpc: "2.0", id: 1, result: { sessionId: "s1", configOptions: [{ id: "model" }, { id: "agent" }] } },
    { jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "usage_update", used: 10, size: 100, cost: { amount: 2, currency: "USD" } } } },
  ];
  const { dir, received } = await runProxy(["--bb-permission-mode=full"], { env: { CLAUDE_BEDROCK_PRICE_FACTOR: "0.5" }, lines, toAgent: [] });
  assert.deepEqual(received[1].result.configOptions, [{ id: "model" }]);
  assert.equal(received[2].params.update.cost.amount, 1);
  const ledger = join(dir, "state", "claude-bedrock", "cost.jsonl");
  for (let i = 0; i < 20 && !existsSync(ledger); i++) await new Promise((r) => setTimeout(r, 50));
  const entry = JSON.parse(readFileSync(ledger, "utf8").trim());
  assert.equal(entry.usd, 2, "the ledger keeps the list price");
  assert.equal(entry.acct, "aws-chain");
  assert.match(entry.key, /^bb:\d+-\d+:s1$/);
});

/** A copy of the plugin's bin/ next to a fake bundled adapter in node_modules. */
function pluginCopy() {
  const dir = mkdtempSync(join(tmpdir(), "bedrock-launcher-"));
  const root = join(dir, "plugin");
  cpSync(join(PLUGIN, "bin"), join(root, "bin"), { recursive: true });
  chmodSync(join(root, "bin", "claude-bedrock-acp"), 0o755);
  writeFakeAdapter(join(root, "node_modules", "@agentclientprotocol", "claude-agent-acp", "dist", "index.js"));
  return { dir, launcher: join(root, "bin", "claude-bedrock-acp") };
}

const launch = (launcher, dir, args, env) => run(launcher, args, cleanEnv(dir, env), [SESSION_NEW], 2);

test("launcher: runs the bundled adapter on Bedrock, with bb's permission mode applied by the proxy", async () => {
  const { dir, launcher } = pluginCopy();
  const keyFile = join(dir, "key");
  writeFileSync(keyFile, "test-key\n");
  const received = await launch(launcher, dir, ["--bb-permission-mode=accept-edits"], { CLAUDE_BEDROCK_KEY_FILE: keyFile });
  assert.deepEqual(received[0].params, { argv: [], useBedrock: "1", region: "us-east-1", token: "test-key" });
  assert.equal(sandboxOf(received).enabled, true);
  const log = readFileSync(join(dir, "state", "claude-bedrock", "launcher.log"), "utf8");
  assert.match(log, /region=us-east-1 credentials=api key from plugin settings adapter=node\n$/);
  assert.doesNotMatch(log, /test-key/, "the log never has the key");
});

test("launcher: the ACP adapter command setting wins over the bundled adapter", async () => {
  const { dir, launcher } = pluginCopy();
  const other = join(dir, "other-adapter.mjs");
  writeFakeAdapter(other);
  const received = await launch(launcher, dir, ["--bb-permission-mode=full"], {
    CLAUDE_AGENT_ACP: `${process.execPath} ${other} --from-setting`,
    AWS_REGION: "eu-central-1",
  });
  assert.deepEqual(received[0].params, { argv: ["--from-setting"], useBedrock: "1", region: "eu-central-1", token: null });
  assert.equal(sandboxOf(received), undefined);
  assert.match(readFileSync(join(dir, "state", "claude-bedrock", "launcher.log"), "utf8"), /credentials=aws credential chain adapter=\//);
});
