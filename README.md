# bb-plugin-claude-bedrock

Branding for the **Claude Code (Bedrock)** ACP agent in bb: gives provider
`acp-claude-bedrock` the Claude mark with an AWS badge.

The agent itself is a `provider-acp` custom agent (`customAgents` entry with id
`claude-bedrock`) that runs Claude Code on AWS Bedrock via
`@agentclientprotocol/claude-agent-acp`.

## Usage entry

Adds estimated spend to bb's Provider usage panel/footer for
`acp-claude-bedrock`: this month and today, after an optional price factor
(default 1, list price), against a monthly budget (default $100; today uses
budget / days in month). Both are plugin settings.

The data is a local ledger, `~/.local/state/claude-bedrock/cost.jsonl`, of
Claude Code's own running cost estimates, appended by the agent's launcher.

bb shows the entry under the raw provider id, because ACP custom agents don't
have the usage capability. Setting `providerUsage: true` on the custom agent
fixes the name, but bb's ACP plugin then also adds an empty "Usage
unavailable" card for it.

Install / update: `bb plugin install .` then `bb plugin reload claude-bedrock`.
