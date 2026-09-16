# OpenCode Hive

Status: concept

Working name: A-Team, short for agent team

Last updated: 2026-09-14

## Summary

OpenCode Hive is a local-first team layer for OpenCode V2. It lets one person
organize named agents across several projects, repositories, branches, and
worktrees while keeping every agent's work visible in ordinary OpenCode and
OpenChamber sessions.

The system adds coordination without replacing the coding environment:

- A long-lived team has a global coordination session.
- Project and detail work happens in normal OpenCode sessions.
- A session acts as the worker's address and visible execution record.
- Untagged messages go to a channel's default agent.
- Named agents remain passive until tagged or assigned work.
- Agents report important boundaries back to the global session.
- A global scribe turns natural-language reports into shared Markdown memory.
- Agent-to-agent work requests require human approval unless an explicit policy
  permits them.
- Completed topics remain searchable and link back to their source sessions.

The first implementation targets stock OpenCode V2 only. OpenChamber integration
is an important presentation layer, but it is not required for the core system.

## Motivation

OpenCode and OpenChamber already make it easy to run many capable sessions. The
remaining burden sits with the human, who must act as the message bus and shared
memory for otherwise isolated agents.

The human currently has to remember:

- Which session owns each line of work.
- Which agent is responsible for each project.
- What one agent needs another agent to know.
- Which requests are safe to execute and which need approval.
- What happened across several repositories and worktrees.
- Which decisions should survive after sessions are compacted or archived.
- Where to find the detailed evidence behind a summary.

Hive moves that coordination into a small, inspectable layer while preserving
OpenCode's native tools, permissions, context management, and session history.

The goal is not maximum agent count. The goal is to reduce the human's
coordination load without hiding what the agents are doing.

## Decisions

The following decisions came out of the initial design discussion.

1. Build for OpenCode V2, not V1.
2. Do not depend on Buzz or `buzz-acp` for the single-user system.
3. Use ordinary OpenCode sessions as channels and execution records.
4. Keep reports and handoffs human-readable and free-form.
5. Stamp provenance in the plugin rather than requiring agents to follow a
   message schema.
6. Use a global scribe to interpret reports and maintain shared Markdown.
7. Let reports trigger a global turn when they deserve interpretation.
8. Keep ambient information retrievable rather than injecting it into every
   agent's context.
9. Treat agent-origin work requests differently from informational reports.
10. Defer custom OpenChamber UI until the behavior works through text and tools.
11. Keep the core independent from OpenChamber so OpenCode-only operation remains
    possible.
12. Add UI through the proposed OpenChamber extension SDK when its contract
    settles, with a narrow downstream patch only if necessary.
13. Support both standalone Hives and Hives embedded in a source repository.
14. Treat a Hive found inside a referenced project as a possible child Hive,
    not as configuration to merge automatically.
15. Link parent and child Hives through explicit federation with clear memory,
    permission, and reporting ownership.
16. Let a parent delegate through a child controller or explicitly bypass it
    with a direct workspace dispatch.
17. Keep detailed project work in child or project-owned memory by default.
    Parent memory tracks cross-project state and links to the details.
18. Detect federation cycles and cap delegation and historical-search depth.

## Non-Goals

Hive does not initially attempt to provide:

- A multi-tenant collaboration server.
- Cryptographic identity between mutually untrusted users.
- A Slack replacement.
- Shared hidden reasoning between agents.
- A vector database or automatic RAG pipeline.
- A rigid task, report, or memory document schema.
- A new coding-agent runtime.
- A replacement for OpenCode permissions.
- A replacement for OpenChamber's chat and activity UI.
- Automatic execution of every agent-to-agent request.

## Architecture

```text
OpenCode Hive team
|
+-- Global coordination session
|   +-- Human conversation
|   +-- Team coordinator
|   +-- Global scribe
|   +-- Boundary reports
|   +-- Handoff approvals
|   +-- Team memory updates
|
+-- Topic: recommendation ranking
|   +-- recsys-world session
|   +-- model-api session
|   +-- infrastructure session
|   +-- reports and handoffs
|
+-- Topic: historical completed work
    +-- archived summary
    +-- source session links
    +-- commits and pull requests
```

The core has three layers:

```text
Team domain
  Team, agent, assignment, topic, report, handoff, memory
        |
OpenCode V2 plugin
  Tools, hooks, session routing, permissions, provenance
        |
Optional OpenChamber extension
  Team panel, links, badges, approvals, topic grouping
```

## Core Concepts

### Team

A team is a long-lived local configuration containing:

- A name and stable ID.
- A global coordination session.
- Named agent definitions.
- Project, repository, branch, and worktree bindings.
- Default and secondary assignments.
- Routing and approval policy.
- Team memory and historical topic summaries.
- Secret capability names and policy, but never secret values.

The team can live in a small home directory that contains configuration and
shared documents but no application source code.

It may also live inside a source repository. An embedded Hive is useful when
one project has several named operational roles, permission profiles, or
specialized agents. A standalone Hive is usually better for coordinating
several repositories.

### Parent And Child Hives

A Hive may reference a project that contains its own Hive configuration. The
outer Hive is the parent and the project Hive is a child only after the user
links them explicitly.

The link does not merge identities or files. Each Hive keeps its own:

- Stable ID and channel.
- Agents and workspace assignments.
- Memory and historical archive.
- Permissions and secret policy.
- Report and handoff records.

Agent names are scoped by Hive, so a parent and child may both define an agent
named `release` without conflict.

### Agent

An agent is a stable named role such as:

- `coordinator`
- `tom`
- `reviewer`
- `pulumi`
- `scribe`

The stable agent identity is separate from an OpenCode execution session. One
agent may have several sessions across topics or project bindings.

### Assignment

An assignment connects an agent to one or more projects or worktrees and gives
it a routing role.

```text
Agent: tom
Projects: recsys-world, model-api
Role: default for recsys-world, secondary for model-api
Capabilities: code, test, open-pr
```

Assignments may overlap. A project has one default agent for untagged work and
zero or more secondary agents for specialized work.

### Session

An OpenCode session is both:

- A visible execution record.
- A routable endpoint for future prompts.

The session ID is the primary local address. A named agent maps to an active
session for a particular topic and project binding.

A new dispatch creates a session for a distinct line of work. A continuation
dispatch reuses an exact mapped session only when the Hive, agent, and workspace
still match. The controller chooses whether work is new or continued. When the
choice is unclear, it may ask the existing thread for a transient `CONTINUE`,
`NEW`, or `UNCLEAR` recommendation without changing that thread's history.

Sessions may be:

- A root OpenCode session created in a registered project or worktree.
- A child session created through OpenCode's task system.
- A fork used to investigate a side path.
- A global coordination session in the team home directory.

Separate sessions do not share hidden context. They share messages, documents,
files, reports, and links that each can retrieve.

### Channel

"Channel" is a user-facing coordination concept implemented with OpenCode
sessions rather than a separate chat server.

- The team global channel is the global coordination session.
- A project channel is a root session bound to a project or worktree.
- A detail channel may be a child or forked session.
- Rejoining means reporting the result back to a parent or global session.

No new transport is required for the single-user version.

### Topic, Goal, And Task

These words may be used loosely in conversation, but their internal meanings
remain distinct.

- A topic is the historical grouping and conversation boundary.
- A goal is a completion criterion driving one session.
- A task is an assignable unit of work inside a topic.

A user-facing work item may create all three together. A topic can contain
several goals across several projects, and one goal may complete while the
larger topic remains open.

Topics can also be named after the work has already happened. For example:

> Close these two lines of work and call it "Added vd_ln to best bets."

Hive should collect the relevant sessions, reports, branches, commits, and pull
requests, then produce a reviewable topic summary.

## Routing

### Project Or Detail Channel

- An untagged human message wakes the channel's default agent.
- `@agent` wakes that named agent's assigned session.
- Other assigned agents remain passive.
- Passive means the agent is not invoked, not that the history is inaccessible.
- A secondary agent may run as a child session when the work belongs in the
  current project.
- A secondary agent may run as a separate root session when the work belongs in
  another registered project or worktree.

### Global Channel

- An untagged message goes to the team coordinator or global default agent.
- Any team agent may be tagged from global, even outside its normal assignment.
- All team agents may retrieve global history.
- Global history is not automatically injected into every active session.
- The coordinator may interpret `@tom do this for me` and dispatch the work to
  Tom's appropriate child or project session.

### Three Separate Decisions

Message handling must distinguish:

- Visible: the agent is authorized to retrieve the message later.
- Delivered: the message enters the agent's current session context.
- Wake: the message starts or continues a model turn.

"Everyone can see global" means visibility, not automatic delivery or wake-up.

## Cross-Session Communication

OpenCode and OpenChamber already support the necessary primitive: an agent can
take another session's ID, send it a prompt, and read the result later.

This was validated on 2026-09-14 across two registered OpenChamber projects. A
sender session in one project used the OpenChamber agent tool to send a prompt
to a session in another project. The target session ran and replied normally,
and both sessions remained visible in OpenChamber.

Hive wraps this primitive with naming, provenance, routing, and policy.

## Provenance

OpenCode conversation roles describe protocol structure, not real-world actors:

- `user` means input to the current session.
- `assistant` means output from the current session's model.

A human prompt, another agent's report, a schedule, and automation can all enter
as user-role input. Hive therefore tracks actor provenance separately.

The plugin obtains trusted source fields from tool execution context:

- Source session ID.
- Source message ID.
- Source agent.
- Directory and worktree.
- Tool call ID when available.

The report body remains unrestricted natural language. The plugin may add a
small readable wrapper such as:

```text
Message from Tom
Source session: ses_...
Source project: recsys-world

I finished the ranking changes. The bug was caused by applying the experiment
weight before normalization. I added regression coverage and opened the PR.
We should remember to apply experiment weights after normalization.
```

V2 metadata stores the same provenance out of band for verification and future
UI. A `team_verify` operation can resolve a report or message ID back to the
authoritative source record when needed.

Agents do not choose their own source identity. The plugin stamps it.

## Message Intent

Hive distinguishes three broad message intents without requiring body schemas.

### Information Or Report

The sender is sharing a result, observation, status, or memory proposal. The
message may be inserted without waking the target or may trigger the global
scribe when interpretation is valuable.

### Request Or Handoff

The sender is asking another agent to perform work. It appears for human review
unless an explicit team policy permits that route.

### Instruction

The target is expected to execute. Agent-origin instructions require human
approval or a matching allow policy. Human instructions follow normal OpenCode
permissions.

The initial implementation may infer intent from the tool used:

- `team_report` means information.
- `team_request` means approval-bearing work request.
- `team_send` is explicit low-level delivery.

The body itself remains free-form.

## Global Scribe

The global scribe is the team memory maintainer. It receives reports, reads
source sessions when necessary, and updates shared Markdown.

The scribe should answer questions such as:

- What happened?
- What changed?
- What decision was made and why?
- What should the team remember?
- What follow-up remains open?
- Which session, commit, PR, or document is the evidence?

The scribe is intentionally model-driven. Humans do not need to produce a report
schema before they can communicate useful information.

### One-Writer Rule

Workers publish reports and memory proposals. The global scribe is the sole
automatic writer of curated global memory. This prevents several agents from
silently overwriting one another's summaries.

Original reports and source sessions remain available after the scribe merges
their content. Derived memory never replaces the evidence.

## Boundary Reports

The global session receives concise reports at meaningful boundaries:

- Topic opened or closed.
- Goal claimed, completed, blocked, or abandoned.
- Handoff proposed, approved, claimed, or completed.
- Commit created.
- Push completed.
- Pull request opened, updated, merged, or closed.
- Deployment started, completed, or failed.
- Important memory proposed or changed.

Not every event must trigger an immediate scribe turn.

- Commits and pushes may be accumulated as information.
- PR open and merge events generally deserve interpretation.
- Goal completion and blockage deserve interpretation.
- Topic closure deserves a scribe turn.
- Work requests deserve an approval flow.

V2's durable queue allows several reports to wait while the scribe is busy. A
later policy may coalesce a burst into one turn.

## Dependent Follow-ups

A human may authorize future work that depends on another worker completing,
for example: "When Brikk finishes the release, have Doris build against it."

Hive stores:

- The source worker session and required status.
- The dependent agent, workspace, request, relevant summary, and memory items.
- The originating OpenCode user-message reference.
- An expiring human grant and its permission scopes.
- Pending, ready, dispatched, cancelled, or expired state.

The source worker never dispatches the dependent work. Its completed report
changes a matching follow-up from pending to ready and notifies the controller.
The controller evaluates the completion evidence. If sufficient, it dispatches
the exact stored target and request using the original unexpired grant. If the
evidence is weak, the grant expired, or the requested action changed, the
controller asks the human again.

Retries use the same follow-up ID. A grant binds to one worker session and later
uses are rejected. The binding must become atomic before concurrent controllers
are supported.

## Handoffs

### Same-System Handoff

A session creates a natural-language request addressed to another named agent.
Hive records the source, target, topic, and approval state, then routes the text
to the target session after approval.

Completion reports return to the requester and global session.

Workers may ask the controller for missing facts or decisions. They should
attempt bounded history backfill first when the answer may already exist. A
question that needs interpretation or human input enters the Hive channel, and
the controller sends the answer back to the same worker session. Workers do not
assign work directly to other workers by default.

A blocking question is itself a blocked-state notification. Hive suppresses a
duplicate blocked report for the same pending question. A controller reply is
first recorded as queued. The worker acknowledges receipt before continuing,
so queue admission is not mislabeled as delivery.

A user may directly instruct a worker to request action from the controller.
This uses a request tool rather than a report. Hive resolves the direct user
message that initiated the worker turn, rejects Hive-generated or synthetic
inputs, and records the OpenCode session ID, user message ID, text digest, and
requested scope. The controller may verify that record before acting.

OpenCode message identity is authoritative even when the human typed through
OpenChamber. OpenChamber links are presentation. A worker report or an
unverified statement that the user approved something never grants authority.

Controllers and workers may retrieve the latest bounded set of Hive reports to
learn who recently did what. This is retrieval, not automatic context injection.

### Cross-System Handoff

Cross-user or cross-system work can use portable Markdown documents identified
by a short ID.

```text
handoff #181714h
```

A basic skill teaches any compatible agent how to:

1. Locate the handoff document.
2. Read its natural-language instructions and references.
3. Verify the local project state.
4. Perform the work in its own system.
5. Update or return a report carrying the same handoff ID.

The participants do not need a shared relay or the same agent runtime.

## Hive Federation

Federation connects a central Hive to a project that already has its own Hive.
It preserves local project control while allowing the parent to coordinate
work across projects.

### Discovery And Linking

When a parent Hive adds a project containing `.hive/config.json`, `.hive.json`,
or `hive.json`, setup should present three choices:

1. Link the project Hive as a child.
2. Ignore the project Hive and treat the checkout as an ordinary workspace.
3. Import selected configuration into the parent after explicit review.

Linking is the recommended default. Discovery alone never creates a parent-child
relationship.

An explicit link records stable Hive IDs and a local config location. Active
channel session IDs remain durable runtime state rather than portable config.

### Delegated Dispatch

The normal parent route is:

```text
Human request
  -> parent controller
  -> child controller
  -> child-selected worker
  -> child report and memory
  -> boundary summary to parent
```

The child controller chooses the local agent and session, maintains project
TODOs, and applies child policy. The parent supplies the request, a bounded
relevant summary, memory items, and a correlation ID.

If the child has no active channel, the parent may offer to start one. It must
not silently claim an unrelated project session as the child controller.

The parent may also dispatch directly into the child project. Direct dispatch
must be explicit because it bypasses child routing and memory. A directly
dispatched worker reports to the parent unless the dispatch says otherwise.

### Ownership

- Workers dispatched by the child report to the child.
- The child sends concise boundary reports to the originating parent.
- The parent does not edit child memory automatically.
- Child permission and secret policy remains final for delegated work.
- A report goes only to the parent that originated its request unless policy
  explicitly permits broader publication.
- Original reports and source sessions remain available in the owning Hive.

A child may eventually have several parents. Every delegated request therefore
needs an origin Hive ID, correlation ID, hop count, and return route.

### Federated History

Historical lookup may traverse linked children. The parent asks each child for
matching summaries and source links rather than copying the child's full
history into central memory.

Results identify the owning Hive and keep their source provenance. Traversal
uses a visited-Hive set, maximum depth, result limit, and timeout. A child may
restrict which memory and session details it exposes upward.

### Failure And Recovery

- An unavailable child remains visible as unavailable rather than being
  replaced by direct dispatch.
- A failed delegation remains retryable under the same correlation ID.
- Duplicate delivery must not create duplicate child work.
- Parent and child restart independently and recover links from stable IDs.
- Cycles such as A -> B -> A are rejected before dispatch.

## Memory

Hive uses four levels of memory.

### Team Memory

Stable conventions, architecture, agent responsibilities, recurring decisions,
and durable operating knowledge.

### Project Or Channel Memory

Repository-specific decisions, constraints, known hazards, and current operating
notes.

### Topic Memory

The active objective, current decisions, status, assignments, and unresolved
questions for one line of work.

### Historical Archive

Closed-topic summaries with links to the source sessions, code changes, tests,
pull requests, and deployments.

Only small active memory should be injected. Historical memory is searched and
retrieved when needed.

### Memory Ownership

Hive memory may be central, project-owned, or hybrid. Hybrid is the recommended
default for a multi-project Hive.

The central controller tracks meta-level state:

- Active goals, owners, and dependencies.
- Branches waiting to merge.
- Releases waiting to publish or verify.
- Cross-project blockers and approvals.
- Links to detailed project TODOs, sessions, commits, and builds.

Project or child memory keeps implementation-level tasks. The parent records a
short status, owner, source location, and freshness marker instead of copying
the whole project TODO list. Backfill may retrieve the project document or ask
the child controller for a current summary.

A Hive may choose fully central memory when that is easier for its work. Memory
placement is policy, not a requirement imposed by federation.

## Markdown As The Shared Brain

The initial shared brain is ordinary Markdown. It may use fenced JSON, command
output, diffs, or tables when those are the clearest representation, but Hive
does not require them.

A possible team directory is:

```text
team/
|-- opencode.json
|-- TEAM.md
|-- MEMORY.md
|-- PROJECTS.md
|-- topics/
|-- reports/
|-- handoffs/
|-- inbox/
`-- .opencode/
    |-- plugins/
    `-- skills/
```

An embedded Hive may use:

```text
project/
`-- .hive/
    |-- config.json
    |-- PLAN.md
    |-- TODO.md
    |-- PROGRESS.md
    `-- archive/
```

Config discovery should check `.hive/config.json`, `.hive.json`, and
`hive.json`. Finding more than one candidate is an error that requires user
selection. Discovery walks from the active directory through its OpenCode
project boundary and does not scan unrelated parents. Embedded files may be
committed for a shared Hive or ignored for a personal Hive. Machine-specific
absolute paths and secret values should not be committed.

Minimal machine state may be stored separately for IDs, session mappings,
delivery state, and locks. Human knowledge stays readable.

The system begins with lexical search over Markdown, session history, and Git.
Semantic retrieval can be added only if normal search proves inadequate.

## Topic Closure

Topic closure should gather:

- Objective and outcome.
- Decisions and rationale.
- Participating projects, branches, and worktrees.
- Commits and pull requests.
- Deployments.
- Tests and other verification.
- Completed and abandoned handoffs.
- Open follow-up work.
- Links to source sessions and messages where supported.

Reliable closure signals include:

- An explicit human request.
- A linked PR merge.
- A linked deployment completing.
- Human approval of an agent's closure suggestion.

Weak signals such as a push, session idle state, or an agent saying "done" should
not close a topic by themselves.

Topics can be created or named retrospectively by selecting or describing the
relevant lines of work.

## Permissions

Agent communication and agent execution are different permissions.

- Reports may normally be delivered automatically.
- Work requests may be visible automatically but require approval to execute.
- Team policy may auto-approve specific source, target, project, and action
  combinations.
- Explicit configured denial remains final.

A useful policy key is:

```text
source agent + target agent + project + intent -> allow | ask | deny
```

OpenCode V2 permission evaluation hooks can enforce this immediately before an
action runs or a permission request is shown.

Worker auto-approval requires an unexpired grant derived from the direct user
message that initiated the dispatch. Hive membership alone is insufficient.
The initial scopes are `ordinary`, `push`, `release`, and `deploy`. Ordinary
scope is always present; the others must be explicitly supported by the user
message and expire with the grant. Secret access is never included in general
worker auto-approval.

Hive installs ask rules for known push, release, and deployment commands and
checks both initially allowed and ask decisions in the permission hook. A
protected action without the matching grant scope is denied rather than left to
client auto-accept behavior.

When a human grants new protected permission while speaking directly in a
worker session, the worker may bind that current OpenCode user message through
an authorization tool. The tool records only the requested scopes and expiry;
it does not treat an older user message or a Hive-generated continuation as
authority.

## Session Environments

Non-secret environment configuration and secret delivery are separate
features. Hive may store ordinary per-agent or per-workspace values such as a
region, backend URL, or feature flag in readable config. Secret values remain
outside Hive config, Markdown, reports, metadata, and plugin storage.

OpenCode V2 currently has a per-session environment operation:

```text
PUT /api/experimental/session/<session-id>/environment
```

The operation replaces the complete process environment used by local shell
commands in that session. OpenCode's generated client exposes it as
`session.environment`, but OpenCode 2.0.3 does not expose it through the plugin
`ctx.session` domain. The Promise and Effect plugin session domains omit the
method, and the plugin host adapters do not forward it.

The shell `create.before` hook can edit an environment map, but its current
event has no session or agent identity. Hive must not use directory matching as
a substitute because several agents may work in the same checkout with
different capabilities.

The preferred upstream change is one of:

1. Expose the existing replacement operation as `ctx.session.environment`.
2. Add get and merge semantics suitable for plugins that need to preserve the
   terminal environment while applying a small overlay.
3. Add session and agent identity to the shell creation hook.

On 2026-09-15, Dax confirmed that OpenCode should expose the session environment
operation through the plugin context and that he plans to add it during API
cleanup. Hive should wait for the resulting contract before choosing replacement
or overlay behavior.

Replacement alone is usable only when Hive has a trustworthy complete baseline
environment. Overlay semantics better match per-agent configuration.

Until OpenCode settles this API, Hive should not rewrite shell commands to
contain values or depend on unsupported access to the server endpoint. Projects
may use narrow wrapper programs that resolve their own credentials from an OS
keyring, 1Password, or another secret manager. The agent invokes the operation
without receiving the credential.

## Secrets

Secret values do not belong in reports, session metadata, team Markdown, or
plugin storage.

Agents request named capabilities, for example:

```text
secret: aws-staging
reason: preview infrastructure for topic 181714h
operation: pulumi preview
```

The preferred design is an operation-specific broker that:

- Identifies the requesting session and agent.
- Checks team and project policy.
- Requests human approval when needed.
- Injects the secret only into the approved child process.
- Avoids returning the value in tool output.
- Records the request and outcome without recording the value.
- Expires approval after one operation or a short TTL.

Secret-broker permission is separate from ordinary worker auto-approval. A Hive
configured to auto-approve normal work must still apply the secret capability's
own allow, ask, or deny policy.

Command-level environment injection improves handling but does not make an
arbitrary shell process safe. A process given a secret can print or misuse it.
Strong secrecy requires narrower operations or sandboxing.

## OpenCode V2 Integration

Hive uses the V2 plugin API directly.

### Prompt Admission Hooks

Inspect and modify incoming prompts before storage. Hive can attach provenance,
classify plugin-origin messages, and force agent-origin work into the queue.

### Per-Message Metadata

Store source session, source agent, topic, intent, and backlinks without
constraining the human-readable message.

### Explicit Queue And Steer

Choose whether a message waits for the current turn or enters it immediately.
Agent-origin work defaults to queue unless a deliberate policy chooses steer.

### Durable Session Inbox

Pending inputs survive interruption and can be listed, cancelled, or moved
between queue and steer.

### Synthetic Messages

Record automation facts without pretending they were typed by the human.

### Informational Insertion

Use `resume: false` when a report should enter history without waking the model.
Use a normal queued prompt when the global scribe should interpret it now.

### Permission Evaluation

Change a proposed operation to allow, ask, or deny based on team policy after
configured rules are evaluated.

### Session Wait

Wait for a session to settle without repeated status polling, then inspect the
actual outcome rather than treating idle as success.

### Durable Execution Events

Use sequenced lifecycle, tool, retry, compaction, and completion events to
reconstruct work after reconnects.

### Plugin Storage

Store team mappings, delivery IDs, cursors, and compact machine state in the
plugin's namespaced durable store.

### Plugin RPC

Expose typed team operations and events to future clients or an OpenChamber
extension.

### Context Hooks

Add bounded team, project, and topic context immediately before model execution.

### Compaction Hooks

Ensure active goals, handoffs, source links, and unresolved work survive session
compaction.

### Shell And Environment Hooks

Inspect command, directory, timeout, shell, and environment before execution.
This is useful for location-wide policy. Per-agent environment injection also
requires session identity, which the OpenCode 2.0.3 shell hook does not provide.

### CLI UI Extensions

An OpenCode-only version may later add terminal panels, dialogs, routes,
commands, notifications, and Markdown renderers.

## Initial Plugin Tools

The exact names may change, but the first useful tool set is:

- `team_init`
- `team_status`
- `team_agents`
- `team_spawn`
- `team_send`
- `team_report`
- `team_request`
- `team_verify`
- `team_remember`
- `team_lookup`
- `team_open_topic`
- `team_close_topic`
- `handoff_create`
- `handoff_claim`
- `handoff_complete`

The tools should stay small. The scribe and coordinator do the interpretation.

## OpenChamber Integration

OpenChamber is the preferred visual client because it already provides:

- Complete session transcripts.
- Tool calls and reasoning display.
- Project and worktree grouping.
- Parent and child session navigation.
- Queue, steer, stop, goals, questions, and permissions.
- Changes and pull request views.
- Session creation and cross-session messaging tools.

Hive should add coordination without replacing those features.

### Current V2 Evidence

As of 2026-09-14, OpenChamber publishes an installable V2 preview:

- Release: `v2-preview`
- Current build at time of review: `2.0.0-preview.4`
- Bundled OpenCode: `2.0.3`
- Source branch: `opencode-v2-refactoring`
- Platforms: Linux, macOS, and Windows

The preview branch is active and is a direct V2 port rather than only an API
compatibility proposal.

OpenCode and OpenChamber maintainers have also established direct communication
around V2 installation compatibility and native V2 support.

### Proposed OpenChamber Extension SDK

OpenChamber PR #3460 proposes `@openchamber/sdk` with capabilities useful to
Hive:

- A right-rail panel and badge.
- Message and session actions.
- Slash commands.
- Attachments with extension-owned private data.
- Session and worktree creation.
- Prompt delivery.
- Session links and lifecycle notifications.
- Conversation reads after explicit user action.
- Approved project and filesystem access.
- Optional local extension services.
- Custom rendering for OpenCode and MCP tools.
- OpenChamber-themed UI primitives.

The extension system is not yet merged. Hive should isolate any dependency on
its host API behind a small adapter.

### Future UI

A Hive extension could provide:

- A pinned team-global view.
- Topics and worker sessions grouped under the team.
- Named-agent status and assignments.
- Pending handoff approvals.
- Boundary reports and unread counts.
- Team memory and historical topic search.
- Session and source links.
- Custom presentation for Hive tools.

Until then, the global session and normal OpenChamber session list are enough to
exercise the complete workflow.

### Narrow Fork Fallback

If the extension SDK does not land, maintain a narrow OpenChamber fork that
keeps Hive files separate and patches only established registries.

Likely additions:

- Team session metadata parser.
- Team sidebar group.
- Provenance badge.
- Handoff approval card.
- Team runtime API adapter.
- Message-level deep-link support.

The text and plugin workflow must continue to work when the UI patch is absent
or temporarily broken by an upstream merge.

## Links

OpenChamber currently supports session-level navigation.

Native form:

```text
openchamber://session/<session-id>?dir=<directory>
```

Web form:

```text
/?session=<session-id>
```

Message and turn anchors exist inside an already loaded session, but a complete
message-level cold-start deep-link contract is future work.

## Reliability Rules

- Every report has a stable delivery ID.
- Retries must not create duplicate work.
- Events are notifications, not the only source of truth.
- Reconnect reads authoritative session and inbox state.
- Idle does not mean success.
- A failed or ambiguous send remains visible and retryable.
- Agent-origin instructions default to queue and approval.
- The scribe never deletes source reports while merging memory.
- Only one automatic writer edits curated global memory.
- Session and topic mappings survive process restart.
- Missing worker mappings may be reconstructed from authoritative session
  metadata when the session was not intentionally detached.
- Reconstructed workers fall back to ask-mode permissions until the controller
  explicitly continues or reattaches them.
- Intentional resets leave a tombstone so old sessions do not silently
  resurrect as active workers.
- Replacing a registered Hive channel uses compare-and-swap against the expected
  current channel ID.
- Context and report sizes are bounded.
- Delegation loops are detected and capped.

## Risks

### Agent Loops

Agents can mention or delegate to one another indefinitely. Requests need a hop
count, correlation ID, bounded retries, and approval defaults.

### Context Growth

The global session can become a dumping ground. It should receive boundary
reports, keep durable state in Markdown, and rely on compaction and retrieval.

### Scribe Omission

The scribe may misunderstand or omit information. Keep source reports and links,
make important memory reviewable, and support correction through normal chat.

### Concurrent Memory Writes

Several writers can lose updates. Use one automatic scribe and atomic or
compare-and-swap document updates.

### Misclassified Instructions

Natural language can blur information and requests. The invoking tool and source
metadata provide the initial classification, while execution still passes
through approval policy.

### API Churn

OpenCode V2 and the OpenChamber extension SDK are moving quickly. Pin tested
versions, capability-check optional features, and isolate adapters.

### Secret Exposure

Environment injection is not a security boundary against an arbitrary process.
Prefer narrow approved operations and preserve an audit trail without values.

## Implementation Sequence

### Phase 1: OpenCode V2 Text Workflow

- Create team home layout.
- Implement team and agent registry.
- Register the global session.
- Create sessions in configured project directories and worktrees.
- Implement cross-session send, report, and request tools.
- Stamp source provenance.
- Link reports back to source sessions.

### Phase 2: Scribe And Memory

- Trigger global turns from important reports.
- Maintain team, project, and topic Markdown.
- Implement topic opening, retrospective naming, and closure.
- Search historical summaries and source sessions.
- Preserve active state during compaction.

### Phase 3: Approval And Secrets

- Add agent-to-agent request approval.
- Add allow, ask, and deny policy.
- Add bounded delegation and retry state.
- Add operation-specific secret requests.
- Add non-secret session environment overlays after OpenCode exposes a supported
  plugin API with safe baseline or merge semantics.
- Keep secret capability approval independent from general worker auto-approval.

### Phase 4: Federation

- Discover embedded Hive configurations while registering projects.
- Link parent and child Hives by stable ID.
- Delegate through child controllers and return boundary reports.
- Support explicit direct-dispatch bypass.
- Traverse child historical summaries with bounded depth and cycle detection.
- Recover links and in-flight correlation state after restart.

### Phase 5: OpenChamber Presentation

- Run against the OpenChamber V2 preview.
- Add an extension adapter after the SDK contract settles.
- Add team panel, badges, links, approvals, and topic grouping.
- Consider a narrow fork only for gaps the extension API cannot cover.

## Success Criteria

Hive is useful when one person can:

1. Open a team-global session.
2. Describe or inspect the team in natural language.
3. Assign named agents to existing projects and worktrees.
4. Talk to the default project agent without naming it.
5. Tag a secondary agent when specialized work is needed.
6. Delegate across projects without manually copying context.
7. Watch every worker in normal OpenCode or OpenChamber sessions.
8. Receive concise global reports with links to detailed work.
9. Approve agent-origin work requests before execution.
10. Close a topic and obtain a useful durable summary.
11. Ask about previous work and follow the answer back to evidence.
12. Resume after restart or compaction without reconstructing the team manually.
13. Link a project Hive as a child and delegate through its controller.
14. Search child history from the parent and follow results to child evidence.

## Open Questions

- Should each agent keep one session per project, one per topic, or both?
- When should the global scribe process reports immediately versus in a batch?
- Which events should be detected automatically and which should require an
  explicit `team_report` call?
- How should a global `@agent` route when that agent has several active sessions?
- How much team memory should enter every worker context?
- Which memory updates require human approval?
- How should retrospective topic grouping select exact session ranges?
- What is the smallest useful secret-broker operation model?
- Which OpenChamber SDK capabilities land unchanged from PR #3460?
- Does Hive need message-level links before the first release?
- When does a local-only team need a server or cross-machine transport?
- May one child Hive report to several parents, and what sharing policy should
  apply?
- Which child operations may a parent perform when the child channel is offline?
- Should direct dispatch into a child project also notify the child Hive?
- Will OpenCode expose `session.environment` through plugin `ctx.session`?
- Should plugin environment updates replace, merge, or patch the current
  session environment?
- How should a plugin obtain the session's baseline terminal environment before
  applying an overlay?

## References

- OpenCode V2 plugins: https://opencode.ai/v2/docs/build/plugins
- OpenCode V2 SDK: https://opencode.ai/v2/docs/build/sdk
- OpenCode session environment PR: https://github.com/anomalyco/opencode/pull/42957
- OpenCode environment configuration discussion: https://github.com/anomalyco/opencode/issues/48919
- OpenChamber V2 preview: https://github.com/openchamber/openchamber/releases/tag/v2-preview
- OpenChamber extension SDK proposal: https://github.com/openchamber/openchamber/pull/3460
- OpenChamber: https://github.com/openchamber/openchamber
- OpenCode: https://github.com/anomalyco/opencode
