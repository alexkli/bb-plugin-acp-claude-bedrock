---
name: claude-bedrock-acp
description: "Configure or troubleshoot the Claude Code (Bedrock ACP) provider (acp-claude-bedrock): Bedrock credentials and region, permission modes and the Bash sandbox, plan approval, /compact, and its estimated-spend usage entry."
---

# Claude Code (Bedrock ACP)

The plugin `acp-claude-bedrock` runs Claude Code on AWS Bedrock as an ACP
agent. Threads use provider `acp-claude-bedrock`; its models are Claude Code's
Bedrock models (`bb provider models acp-claude-bedrock`).

The plugin keeps one entry, id `claude-bedrock`, in the ACP agents plugin's
`customAgents` setting and rewrites it on every load and settings change. It
owns `command`, `args`, `displayName`, `permissionCli`,
`supportsManualCompaction` and the env variables in the table below; edits to
those are overwritten. Other env variables and fields in the entry are kept.
Change the plugin's settings instead of the entry.

## Settings

Set with `bb plugin config acp-claude-bedrock set <key> <value>`, or on
Settings → Plugins → Claude Bedrock ACP provider. A change applies when a
thread's agent next starts.

| Key | Meaning | Env in the entry |
| --- | --- | --- |
| `apiKey` | Bedrock API key (secret). Written to a 0600 key file; the entry has only its path. | `CLAUDE_BEDROCK_KEY_FILE` |
| `region` | AWS region, default `us-east-1`. | `AWS_REGION` |
| `awsProfile` | AWS profile for the credential chain, used without an API key. | `AWS_PROFILE` |
| `adapterCommand` | Command for a different claude-agent-acp. Default: the adapter bundled with the plugin. | `CLAUDE_AGENT_ACP` |
| `sandbox` | Bash sandbox in Accept Edits, default `true`. | `CLAUDE_BEDROCK_SANDBOX=0` when `false` |
| `priceFactor` | Multiplier on Claude Code's list-price cost, default `1`. | `CLAUDE_BEDROCK_PRICE_FACTOR` |
| `monthlyBudgetUsd` | Budget for the usage entry, default `100`. | none |

Credentials, in order: the `apiKey` setting, the macOS keychain item
`claude-bedrock-token` (account `$USER`), then the AWS credential chain. Never
print the key or the key file's contents.

## Permission modes and the sandbox

bb's ACP permission modes are Accept Edits and Full Access. bb starts the
launcher with `--bb-permission-mode=accept-edits` or `--bb-permission-mode=full`
and restarts the agent when a thread's mode changes.

- Accept Edits: Bash runs in Claude Code's OS sandbox, as with bb's Claude Code
  provider. Writes are limited to the workspace and the thread's extra folders.
  "Operation not permitted" on a write elsewhere is the sandbox: edit inside
  the workspace, or ask the user; a command run outside the sandbox needs their
  approval in bb.
- Full Access: no sandbox, and bb approves every permission request.

Claude Code's own permission mode (Auto, Default, Plan, ...) is the separate
`mode` session option: `bb thread options <thread-id>`.

## Plan approval and compaction

In plan mode the proxy holds Claude's "Ready to code?" request, opens the plan
from the thread's storage folder (`plans/`), and asks the user in bb, even in
Full Access. `CLAUDE_BEDROCK_ASK_PLAN_APPROVAL=0` in the entry's env turns this
off. `/compact` and `bb thread compact <thread-id>` run Claude Code's
compaction.

## Usage and troubleshooting

- Estimated spend: Provider usage panel, from the ledger
  `${XDG_STATE_HOME:-~/.local/state}/claude-bedrock/cost.jsonl` (list-price
  estimates, not the AWS bill).
- Each launch appends one line (region, credential source, adapter; never the
  key) to `${XDG_STATE_HOME:-~/.local/state}/claude-bedrock/launcher.log`.
  `adapter=node` means the bundled adapter.
- `bb acp-claude-bedrock status` checks the launcher, the adapter, the agent
  entry, bb's provider registration and the credential source; it exits
  non-zero when something needs attention. `bb acp-claude-bedrock repair`
  rewrites the entry. If the plugin shows as needing configuration in
  `bb plugin list`, fix the reason it gives, then run `repair`.
- `bb acp-claude-bedrock unregister` removes the entry; run it before
  `bb plugin remove acp-claude-bedrock` (bb has no uninstall hook).
- Plugin errors: `~/.bb/plugins/acp-claude-bedrock/logs/plugin.log`. Reload
  with `bb plugin reload acp-claude-bedrock`.
- An authentication error in a thread usually means no usable credential:
  check the settings, the keychain item, or `AWS_PROFILE`.
