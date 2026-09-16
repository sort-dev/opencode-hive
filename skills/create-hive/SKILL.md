---
name: Create Hive
description: Create or extend an OpenCode Hive in the current directory by discovering projects, Git worktrees, models, and named agents through conversation.
---

# Create or extend a Hive

Use this skill when the user asks to create a Hive in the current directory, add projects or worktrees to a Hive, or configure named Hive agents.

Hive setup is conversational. Do not require a setup UI.

## Rules

- Never scan the user's whole home directory without approval.
- Treat filesystem and Git results as authoritative for paths, branches, and worktree membership.
- If the OpenChamber tool is available, prefer its project registry and model list for user-facing names and available models.
- Use OpenCode V2 project and session metadata as a fallback or to disambiguate historical paths.
- Session paths are candidates. Verify them with Git before writing `hive.json`.
- Ask when two paths, branches, projects, or agent assignments remain ambiguous.
- Do not put secret values in Hive configuration or Markdown.
- When extending an existing Hive, preserve its ID, channel, agents, projects, and unrelated fields.

## Discovery

1. Check for `.hive/config.json`, `.hive.json`, or `hive.json` in the current directory and its ancestors through the project root. Stop and ask if several candidates exist.
2. If the OpenChamber tool is available:
   - Call `projects.list` for registered project names and roots.
   - Call `models.list` before offering model choices.
   - Use `session.list` only when recent sessions would help resolve a project name, worktree, or prior line of work.
3. Show the registered project candidates and ask which project groups the user wants inspected. Do this before accessing paths outside the Hive directory.
4. Verify only the selected repositories with the bundled discovery script. Pass exact project paths when possible:

   ```sh
   bun <skill-directory>/scripts/discover-git.ts /path/to/project /path/to/another-project
   ```

5. Show the discovered worktrees and ask which ones to include.
6. If no registry is available or the user wants more choices, ask which parent directories may be searched. A normal choice is `~/DEV`. Pass those approved roots to the same script.
7. If using the OpenCode CLI as a fallback, first confirm that the selected binary reports V2. Useful API routes are:
   - `GET /api/project`
   - `GET /api/session`
   - `GET /api/debug/location`
   - `GET /api/worktree`

The script recognizes normal repositories and linked worktrees, groups checkouts by their common Git directory, and returns each current branch.

## Questions

Show the discovered project and worktree candidates, then ask the user:

1. Which projects and worktrees belong in this Hive?
2. What should each named Hive agent be called?
3. Which available model and OpenCode agent profile should each Hive agent use?
4. Which agent is the default for each workspace?
5. Which agent should coordinate and scribe the Hive channel?
6. Should launched workers ask for permissions or auto-approve anything not explicitly denied?

Ask in small batches. Keep sensible defaults editable so the user can add more projects and agents later.

## Files

Read `references/hive-format.md` before writing configuration. Create these files when absent:

```text
hive.json
AGENTS.md
PLAN.md
TODO.md
PROGRESS.md
```

The globally enabled Hive plugin discovers `.hive/config.json`, `.hive.json`, or `hive.json` through the project boundary. No global Hive config edit is needed.

After the user approves the configuration:

1. Write or update the files.
2. Call `hive_init` from the intended Hive channel.
3. Call `hive_status` and show the resulting agents and workspaces.
4. Do not dispatch work unless the user asks.

If another channel is already registered, explain which session owns it and ask before using `replace: true`. Use `clearHistory: true` only when the user explicitly requests a clean demo or reset.
