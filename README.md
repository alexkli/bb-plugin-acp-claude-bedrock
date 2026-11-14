# bb-plugin-claude-bedrock

Claude Code on **AWS Bedrock** as an agent in [bb](https://getbb.app), shown as
**Claude Code (Bedrock)** in the provider picker. It has these parts:

- `bin/claude-bedrock-acp`: the launcher script. It runs Claude Code in Bedrock
  mode over ACP, using
  [`@agentclientprotocol/claude-agent-acp`](https://www.npmjs.com/package/@agentclientprotocol/claude-agent-acp).
- `bin/claude-bedrock-acp-proxy.mjs`: a small ACP proxy started by the
  launcher. It applies an optional price factor to the cost bb shows, hides the
  subagent picker option and records spend in a local ledger.
- The bb plugin, which gives the provider (`acp-claude-bedrock`) the Claude mark
  with an AWS badge as its icon, and adds an estimated-spend entry to bb's
  Provider usage panel.

The agent itself is a bb ACP custom agent. This plugin does not register a
provider and uses only the public plugin SDK.

## Requirements

- bb 0.49 or later, with the built-in ACP agents plugin (`provider-acp`).
- Node.js and [Claude Code](https://claude.com/claude-code) (`claude` on PATH).
  Without `claude`, the ACP adapter uses its bundled Claude Code.
- Bedrock access to the Anthropic models, and either a
  [Bedrock API key](https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys.html)
  or AWS credentials that Claude Code can use (see
  [Claude Code on Amazon Bedrock](https://docs.claude.com/en/docs/claude-code/amazon-bedrock)).

## Setup

1. Clone the repo, then install and build the plugin:

   ```sh
   git clone https://github.com/alexkli/bb-plugin-claude-bedrock.git
   cd bb-plugin-claude-bedrock
   npm install
   bb plugin build
   bb plugin install .
   ```

2. Install the ACP adapter (optional; without it, the launcher uses `npx`,
   which is slower to start):

   ```sh
   npm install -g @agentclientprotocol/claude-agent-acp
   ```

3. Provide credentials. bb starts agents without your shell profile, so the
   launcher looks in these places, in order:
   - `AWS_BEARER_TOKEN_BEDROCK` in the agent's `env` (step 4).
   - On macOS, the keychain. Store the key once:

     ```sh
     security add-generic-password -a "$USER" -s claude-bedrock-token -w
     ```

   - Otherwise, the normal AWS credential chain. For example, set `AWS_PROFILE`
     in the agent's `env`.

4. Register the agent in bb, either in the ACP agents plugin's settings
   (Custom agents) or with `bb plugin config provider-acp set customAgents '<json>'`.
   The id must be `claude-bedrock`, so that the provider id is
   `acp-claude-bedrock`:

   ```json
   [
     {
       "id": "claude-bedrock",
       "displayName": "Claude Code (Bedrock)",
       "command": "/absolute/path/to/bb-plugin-claude-bedrock/bin/claude-bedrock-acp",
       "args": [],
       "env": { "AWS_REGION": "us-west-2" },
       "nativeSkillRoots": { "user": [".claude/skills"], "project": [".claude/skills"] }
     }
   ]
   ```

   If you already have custom agents, add this entry to the existing array.

5. Pick **Claude Code (Bedrock)** in a new thread.

### Launcher options

Set these in the custom agent's `env`. All are optional.

| Variable | Default | |
| --- | --- | --- |
| `AWS_REGION` | `us-east-1` | Bedrock region |
| `AWS_BEARER_TOKEN_BEDROCK` | keychain | Bedrock API key |
| `CLAUDE_BEDROCK_KEYCHAIN_SERVICE` | `claude-bedrock-token` | Keychain service name for the key |
| `CLAUDE_AGENT_ACP` | `claude-agent-acp`, else `npx` | Command that runs the ACP adapter |
| `CLAUDE_CODE_EXECUTABLE` | `claude` on PATH | Claude Code binary |
| `CLAUDE_BEDROCK_PRICE_FACTOR` | `1` | Multiplier on the cost bb shows in a thread |
| `CLAUDE_BEDROCK_ACP_HIDE_OPTIONS` | `agent` | Comma-separated ACP config options to hide |

Other Claude Code variables, such as `ANTHROPIC_MODEL` or
`ANTHROPIC_DEFAULT_HAIKU_MODEL`, pass through as well.

## Usage entry

The plugin adds estimated spend for `acp-claude-bedrock` to bb's Provider usage
panel and footer: this month and today, measured against a monthly budget.
Today's budget is the monthly budget divided by the days in the month. There
are two plugin settings:

- **Monthly budget (USD)**, default 100.
- **Price factor**, default 1 (list price). If you have a negotiated Bedrock
  discount or markup, set it here, e.g. 0.8 for 20% below list. Use the same
  value as `CLAUDE_BEDROCK_PRICE_FACTOR`.

The data comes from a local ledger,
`${XDG_STATE_HOME:-~/.local/state}/claude-bedrock/cost.jsonl`, of Claude Code's
own running list-price cost estimates. The proxy appends one line whenever a
bb thread's cost changes. Other tools can append terminal sessions in the same
format: `{"t": <epoch ms>, "src": "cli", "key": "<unique session id>", "usd": <running list-price USD>}`.
Only spend recorded in the ledger is counted. This is an estimate, not your
AWS bill.

bb lists the entry under the raw provider id, because ACP custom agents don't
have the usage capability. Setting `"providerUsage": true` on the custom agent
fixes the name, but then bb's ACP plugin also adds an empty "Usage
unavailable" card for it.

## Development

`bb plugin build` compiles the plugin into `dist/`, and
`bb plugin reload claude-bedrock` reloads it. `npx tsc -p .` type-checks it.

## License

MIT
