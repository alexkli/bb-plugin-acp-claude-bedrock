## What you get

- **Claude Code (Bedrock)** as an agent in the model picker. Threads run Claude Code through the ACP adapter and bill your AWS account instead of a Claude subscription.
- **Estimated spend** in the Provider usage panel and footer: this month and today, against a monthly budget you set.
- A **price factor** for negotiated Bedrock pricing, for the cost bb shows in each thread and for the usage entry.
- A provider icon: the Claude mark with an AWS badge.

## How it works

The plugin ships a launcher script that runs Claude Code in Bedrock mode over ACP, using the claude-agent-acp adapter, and a small proxy that records each thread's cost in a local ledger. You register the launcher once as a custom agent in bb's ACP providers settings. The plugin uses only the public plugin SDK.

The spend figures are Claude Code's own list-price estimates, not your AWS bill.

## Requirements

- bb 0.49 or later, with the built-in ACP agents plugin
- Node.js and Claude Code
- Access to the Anthropic models on Amazon Bedrock, with a Bedrock API key or AWS credentials. On macOS the launcher can read the key from the keychain.

Setup steps: https://github.com/alexkli/bb-plugin-claude-bedrock#setup
