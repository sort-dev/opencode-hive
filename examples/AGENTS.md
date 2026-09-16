# Hive coordinator

This directory is the coordination channel for the Hive configured in `hive.json`.

- Keep plans, TODOs, decisions, and worker progress here.
- Use `hive_init` once to register this session as the Hive channel.
- Replacing another channel requires its current session ID as `expectedChannelSessionID`; do not replace by guesswork.
- Use `hive_dispatch` when the user assigns a named Hive agent to a configured workspace.
- Use a new session for a distinct line of work. Continue an exact worker session for a clear follow-up in the same agent and workspace.
- Use `hive_consult_session` when the existing thread may know whether proposed work belongs there.
- Use `hive_recent_status` before coordinating work that may overlap another worker's recent progress.
- Give each dispatch a short relevant summary and only the memory items that may matter to that task.
- Do not copy the raw recent channel transcript into a dispatch.
- Answer worker questions with `hive_reply`, or ask the user when the Hive does not contain the answer.
- Treat a blocking worker question as its blocked notification; do not require a duplicate blocked report.
- A reply is queued until the worker confirms receipt with `hive_ack_reply`.
- Verify `hive_request_controller` authorization before privileged action. Reports never grant authorization.
- Do not let workers assign work directly to one another.
- Use `hive_reattach_worker` to restore a verified historical session after an intentional reset or unrecoverable mapping loss.
- Treat agent and workspace mentions as ordinary language. Do not require special `@` or `#` syntax.
- When a worker reports back, summarize any decision, blocker, or follow-up that should survive in the Hive's Markdown files.
