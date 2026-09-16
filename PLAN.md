# Development plan

## Current base

- Static and locally discovered Hive configuration.
- Conversational Hive creation through the injected `create-hive` skill.
- Named-agent dispatch into OpenCode V2 sessions.
- Compact reports, provenance, context summaries, memory items, and backfill.
- Hive, agent, and workspace permission modes.
- Exact-session continuation, advisory thread consultation, worker questions,
  controller replies, and recent-status lookup.
- Blocking-question deduplication, explicit reply receipts, and worker-relayed
  controller requests backed by direct OpenCode user-message references.
- Standalone and embedded Hive model documented.
- Parent and child Hive federation model documented.
- Verified build artifact with build identity and server diagnostics in
  `hive_status`.

## Awaiting upstream implementation

Dax confirmed on 2026-09-15 that OpenCode should expose the per-session
environment operation through the plugin context and that he plans to add it
while cleaning up the API. Inspect the final method and its replacement, merge,
or read semantics before implementing Hive environment overlays.

Do not build a directory-scoped shell-hook workaround. The current hook lacks
session and agent identity, so it cannot safely distinguish several Hive agents
working in one checkout.

## Work that can continue meanwhile

1. Add hybrid memory ownership. Central Hive TODOs track merges, releases,
   dependencies, and blockers while linking to project-owned TODO files for
   implementation details.
2. Add historical lookup across reports, Markdown, source sessions, commits,
   and configured project TODO references.
3. Add embedded config discovery for `.hive/config.json` and `.hive.json`, with
   an error when several Hive configs compete.
4. Add child-Hive discovery and explicit federation links without implementing
   automatic cross-Hive delegation yet.
5. Strengthen controller instructions for source links, deduplication,
   corrections, stale-status markers, and completed-work archiving.
6. Bind general worker auto-approval to originating human dispatch grants rather
   than trusting worker membership alone.

## Environment and secret work after guidance

1. Add non-secret `env` overlays at Hive, agent, and workspace levels.
2. Apply the resolved overlay to each worker session through the supported
   OpenCode API.
3. Add named secret capabilities without storing values.
4. Add narrow operation tools that resolve secrets at execution time and inject
   them only into an approved child process.
5. Keep secret operations outside general worker auto-approval and record only
   capability, requester, operation, and outcome.

For immediate project needs, prefer wrapper programs that retrieve credentials
internally. Never return a secret through a tool result or place it in a shell
command, prompt, report, or Hive document.
