# bb-plugin-acp-claude-bedrock

Claude Code on **AWS Bedrock** as an ACP agent in [bb](https://getbb.app), shown
as **Claude Code (Bedrock ACP)** in the provider picker. It has these parts:

- `bin/claude-bedrock-acp`: the launcher script. It runs Claude Code in Bedrock
  mode over ACP, using
  [`@agentclientprotocol/claude-agent-acp`](https://www.npmjs.com/package/@agentclientprotocol/claude-agent-acp).
- `bin/claude-bedrock-acp-proxy.mjs`: a small ACP proxy started by the
  launcher. It applies the price factor to the cost bb shows, hides the
  subagent picker option, records spend in a local ledger, and makes plan mode
  ask before it implements (see [Plan mode](#plan-mode)).
- The bb plugin. It registers the launcher as the custom agent `claude-bedrock`
  (provider `acp-claude-bedrock`) in bb's ACP agents plugin and keeps that entry
  up to date, passes the plugin settings to the agent, gives the provider the
  Claude mark with an AWS badge as its icon (monochrome, to tell it apart from
  the colored icon of the Claude Bedrock provider plugin), and adds an
  estimated-spend entry to bb's Provider usage panel. It uses only the public plugin SDK.

## Screenshots

**Claude Code (Bedrock ACP)** in the model picker, with its estimated spend in the
Provider usage panel (bottom left):

![New thread with the Claude Code (Bedrock ACP) provider selected and its model list open; the Provider usage panel shows this month and today against the budget](docs/overview.png)

The plugin settings: API key, region, adapter, budget and price factor.

![Claude Bedrock ACP provider settings with API key, region, profile, adapter command, monthly budget and price factor](docs/settings.png)

## Requirements

- bb 0.49 or later, with the built-in ACP agents plugin (`provider-acp`).
- Node.js and [Claude Code](https://claude.com/claude-code) (`claude` on PATH).
  Without `claude`, the ACP adapter uses its bundled Claude Code.
- Bedrock access to the Anthropic models, and either a
  [Bedrock API key](https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys.html)
  or AWS credentials that Claude Code can use (see
  [Claude Code on Amazon Bedrock](https://docs.claude.com/en/docs/claude-code/amazon-bedrock)).

## Setup

1. Install the plugin. From a clone:

   ```sh
   git clone https://github.com/alexkli/bb-plugin-acp-claude-bedrock.git
   cd bb-plugin-acp-claude-bedrock
   npm install
   bb plugin build
   bb plugin install .
   ```

   On load, the plugin adds **Claude Code (Bedrock ACP)** to bb's ACP agents.
   It updates that entry on every load, so a plugin update that moves the
   launcher needs no action. Other custom agents are left alone.

2. Open Settings → Plugins → **Claude Bedrock ACP provider** and set:
   - **Bedrock API key**. bb stores it as a secret setting. The plugin writes
     it to a file only your user can read
     (`~/.bb/plugins/acp-claude-bedrock/host-data/bedrock-api-key`) and gives
     the agent only that file's path, so the key never appears in the ACP
     agents config. Without a key, the launcher uses the macOS keychain item
     `claude-bedrock-token` if present
     (`security add-generic-password -a "$USER" -s claude-bedrock-token -w`),
     else the normal AWS credential chain. Set **AWS profile** for the latter.
   - **AWS region**, default `us-east-1`.

3. The ACP adapter ships with the plugin as a dependency
   (`@agentclientprotocol/claude-agent-acp`, installed by `npm install`), so
   there is nothing to install. To use a different one, point **ACP adapter
   command** at it, e.g.
   `node /path/to/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js`.

4. Pick **Claude Code (Bedrock ACP)** in a new thread.

### Settings and launcher variables

The plugin passes its settings to the agent as environment variables in the
agent entry. You can add more variables to the entry's `env` in the ACP agents
settings; the plugin keeps them.

| Setting | Variable | Default |
| --- | --- | --- |
| AWS region | `AWS_REGION` | `us-east-1` |
| AWS profile | `AWS_PROFILE` | unset |
| ACP adapter command | `CLAUDE_AGENT_ACP` | the plugin's bundled adapter, else `claude-agent-acp` on PATH, else `npx` |
| Price factor | `CLAUDE_BEDROCK_PRICE_FACTOR` | `1` |
| Bedrock API key | `CLAUDE_BEDROCK_KEY_FILE` (path to the key file) | unset |

Launcher-only variables: `CLAUDE_CODE_EXECUTABLE` (default `claude` on PATH),
`CLAUDE_BEDROCK_KEYCHAIN_SERVICE` (default `claude-bedrock-token`) and
`CLAUDE_BEDROCK_ACP_HIDE_OPTIONS` (default `agent`, comma-separated ACP config
options to hide). Other Claude Code variables, such as `ANTHROPIC_MODEL`, pass
through as well. Each launch appends one line (time, region, credential source,
adapter; never the key) to `~/.local/state/claude-bedrock/launcher.log`.

## Plan mode

In plan mode, Claude ends planning with "Ready to code?", which the ACP
adapter sends to bb as a permission request. In Full Access, bb answers every
permission request itself, so the plan would be approved without asking you
and Claude would go straight to implementing. The proxy holds that request
and instead:

- copies the plan into the thread's storage folder (`plans/<name>.md`) and
  keeps the copy in sync with Claude's plan file
  (`~/.claude/plans/<name>.md`), so an open plan updates by itself when you
  ask for changes;
- adds a "Plan ready for review" card to Claude's message
  (`::claude-bedrock-plan{file="plans/<name>.md"}`, rendered by this plugin's
  app). The first time a bb window shows the card, it opens the plan in that
  window's side panel; windows on other threads are left alone, and coming
  back to the thread later doesn't open it again. "Open plan" on the card
  opens it any time;
- asks you a question, which bb shows in every permission mode, with
  Claude's options, such as "Yes, and use auto mode", "Yes, manually approve
  edits" and "No, keep planning" (at most four; bb can't show more).

Your answer goes back to Claude as the permission decision. To change the
plan, pick "No, keep planning": Claude stays in plan mode and the turn ends,
so send your feedback as a message and Claude revises the plan (the adapter
takes no text with the answer itself). Dismissing the question also keeps
Claude in plan mode. Set `CLAUDE_BEDROCK_ASK_PLAN_APPROVAL=0` in the agent's
`env` to leave the request to bb instead.

## Usage entry

The plugin adds estimated spend for `acp-claude-bedrock` to bb's Provider usage
panel and footer: this month and today, measured against a monthly budget.
Today's budget is the monthly budget divided by the days in the month. There
are two plugin settings for it:

- **Monthly budget (USD)**, default 100.
- **Price factor**, default 1 (list price). If you have a negotiated Bedrock
  discount or markup, set it here, e.g. 0.8 for 20% below list. It also
  applies to the cost bb shows in each thread.

The data comes from a local ledger,
`${XDG_STATE_HOME:-~/.local/state}/claude-bedrock/cost.jsonl`, of Claude Code's
own running list-price cost estimates. The proxy appends one line whenever a
bb thread's cost changes (src `bb`). Other tools can append terminal sessions
in the same format: `{"t": <epoch ms>, "src": "cli", "acct": "<credential, see below>", "key": "<unique session id>", "usd": <running list-price USD>}`.
The Claude Bedrock provider plugin writes to the same ledger (src
`bb-claude-code`). Each line also names the Bedrock credential it was spent
with (`acct`): `key:` and 12 hex characters of the API key's SHA-256 (never the
key), `profile:<name>`, or `aws-chain`. The entry counts all lines for the
credential this plugin uses (API key setting, else keychain, else AWS
profile), whatever wrote them, so the budget covers everything spent with that
key on this machine; lines without `acct` count for every credential. Only
spend recorded in the ledger is counted. This is an estimate, not your
AWS bill.

bb lists the entry under the raw provider id, because ACP custom agents don't
have the usage capability. Setting `"providerUsage": true` on the custom agent
fixes the name, but then bb's ACP plugin also adds an empty "Usage
unavailable" card for it.

## Development

`bb plugin build` compiles the plugin into `dist/`, and
`bb plugin reload acp-claude-bedrock` reloads it. `npx tsc -p .` type-checks it,
and `npm test` runs the proxy's tests.

## License

MIT
