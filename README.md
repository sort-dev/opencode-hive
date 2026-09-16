# OpenCode Hive

> [!WARNING]
> **Work in progress.** This repository is an early development prototype. It is incomplete, its configuration and behavior may change without notice, and it is not ready or supported for use by other parties yet.

OpenCode Hive is an early V2 plugin for dispatching named agents into configured project workspaces while keeping coordination in one Hive channel.

The current spike supports:

- A static `hive.json`
- One registered channel per Hive
- Named Hive agents backed by normal OpenCode agents
- Worker sessions created in configured directories
- Coordinator-written relevant summaries and memory items in dispatches
- Worker context backfill from Hive updates, Markdown, reports, and related sessions
- New-session and exact-session continuation dispatch
- Advisory consultation with existing worker context
- Worker questions, controller replies, and recent report lookup
- Worker reply receipts and verified user-authorized requests to the controller
- Worker identity recovery, explicit reattachment, reset tombstones, and compare-and-swap channel replacement
- Hive, agent, and workspace permission modes for launched workers
- Progress reports routed back to the Hive channel
- Durable worker-to-Hive mappings

## Requirements

- OpenCode V2
- Bun

The plugin API used here is not compatible with OpenCode V1.

## Configure a Hive

Copy `examples/hive.json` and `examples/AGENTS.md` into a separate Hive directory. Replace the example workspace paths with absolute paths or paths relative to `hive.json`.

Configure the plugin globally in V2. The plugin does not require a Hive configuration merely to load:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "/absolute/path/to/opencode-hive"
  ]
}
```

The global install provides the `create-hive` skill and Hive tools in every covered project. In a directory without a Hive, say "create me a Hive here." Tools that require an existing Hive explain that setup is needed.

Hive discovery checks the current directory and its ancestors through the OpenCode project boundary. It accepts `.hive/config.json`, `.hive.json`, or `hive.json`. Competing files are rejected instead of choosing one silently. Worker sessions retain the originating config path in their durable Hive mapping, so their report and backfill tools do not require a local config file.

For development, load the compiled root entrypoint and run `bun run verify` before restarting OpenCode. The root `index.js` imports `dist/index.js`, so edits under `src/` do not hot-reload active locations until a new build changes the artifact.

The OpenChamber V2 preview also writes an `opencode.managed.json` file. In preview build `2.0.0-preview.4`, its `plugins` array can replace the normal global plugin list. For development, add Hive beside `openchamber-agent-tool` in that managed file. OpenChamber may rewrite the file, so this is temporary until its plugin configuration settles.

## Try the round trip

1. Start an OpenCode V2 session in the Hive directory.
2. Ask it to initialize the Hive. The coordinator calls `hive_init`.
3. Ask it to send a named agent to a configured workspace. The coordinator calls `hive_dispatch` in `new` or `continue` mode.
4. Open the returned worker-session link if you want to watch or answer it directly.
5. Worker calls to `hive_report` arrive as queued prompts in the Hive channel.
6. A worker that needs more context calls `hive_backfill_details` with a focused question.
7. A worker that still needs a decision calls `hive_ask_controller`; the controller answers with `hive_reply`.
8. The worker acknowledges receipt with `hive_ack_reply`. Direct user instructions relayed from a worker use `hive_request_controller` and retain their OpenCode message reference.

When replacing a channel, pass both `replace: true` and the currently registered channel as `expectedChannelSessionID`. An intentional `clearHistory` reset detaches workers without deleting their OpenCode sessions. Detached sessions do not silently recover; restore one with `hive_reattach_worker` after verifying its agent and workspace. Automatically reconstructed workers use `ask` permissions until the controller explicitly continues or reattaches them.

Special mention syntax is not required. Ordinary phrasing is enough as long as the coordinator resolves it to the typed dispatch tool.

The coordinator should pass a short `relevantSummary` and a small list of `memoryItems` to `hive_dispatch`. Hive does not copy raw recent channel messages into every new worker. Backfill retrieves newer channel updates and asks the Hive channel for a focused answer without adding another channel turn.

## Current limits

- Reports wake the Hive channel rather than accumulating silently.
- Branch names are resolved from config but are not checked against Git yet.
- Per-session environment overlays are waiting on a supported OpenCode plugin
  API. The HTTP client can replace a session environment, but `ctx.session`
  cannot currently call it.
- Secret capabilities are not implemented. Do not put secret values in Hive
  configuration or reports.
- The development entrypoint is the root `index.js`; it imports the verified `dist/index.js` artifact.

## Development

```sh
bun install
bun run verify
```
