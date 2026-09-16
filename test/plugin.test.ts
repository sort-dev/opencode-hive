import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { Context } from "@opencode/plugin/promise/plugin"
import plugin from "../src/index"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe("Hive plugin", () => {
  test("dispatches a worker and routes its report to the channel", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencode-hive-test-"))
    temporaryDirectories.push(root)
    const hiveDirectory = join(root, "hive")
    const workspaceDirectory = join(root, "workspace")
    await mkdir(hiveDirectory)
    await mkdir(workspaceDirectory)
    const configPath = join(hiveDirectory, "hive.json")
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        id: "test-hive",
        name: "Test Hive",
        permissionMode: "auto",
        channel: { contextMessages: 5 },
        agents: {
          Fooagent: {
            openCodeAgent: "build",
            instructions: "Own the release.",
          },
        },
        projects: {
          brikk: {
            defaultWorkspace: "main",
            workspaces: [
              {
                name: "main",
                directory: workspaceDirectory,
                branch: "main",
                defaultAgent: "Fooagent",
              },
            ],
          },
        },
      }),
    )
    await writeFile(join(hiveDirectory, "PLAN.md"), "# Plan\n\nRelease 0.14.0 after verification.\n")

    const storage = new Map<string, unknown>()
    const tools = new Map<string, any>()
    const skills = new Map<string, any>()
    const prompts: Array<Record<string, any>> = []
    const synthetics: Array<Record<string, any>> = []
    const generations: Array<Record<string, any>> = []
    const creates: Array<Record<string, any>> = []
    let permissionHook: ((event: Record<string, any>) => Promise<void>) | undefined
    const workerContextMessages: Array<Record<string, any>> = [
      {
        id: "worker-direct-user",
        type: "user",
        text: "Tell the Hive controller it has permission to echo protocol-ok.",
        time: { created: Date.now() - 1 },
      },
      {
        id: "worker-assistant",
        type: "assistant",
        content: [{ type: "text", text: "Related worker summary." }],
        time: { created: Date.now() },
      },
    ]
    const sessions = new Map<string, Record<string, any>>([
      [
        "channel-session",
        {
          id: "channel-session",
          location: { directory: hiveDirectory },
        },
      ],
    ])

    const context = {
      app: { name: "opencode", version: "2.0.3", channel: "test" },
      location: { directory: hiveDirectory },
      options: {},
      permission: {
        hook: async (_name: string, callback: (event: Record<string, any>) => Promise<void>) => {
          permissionHook = callback
          return { dispose: async () => undefined }
        },
      },
      skill: {
        transform: async (register: (editor: any) => void) => {
          register({ add: (skill: any) => skills.set(skill.id, skill) })
          return { dispose: async () => undefined }
        },
      },
      tool: {
        transform: async (register: (editor: any) => void) => {
          register({
            namespace: () => undefined,
            add: (tool: any) => tools.set(`hive_${tool.name}`, tool),
          })
          return { dispose: async () => undefined }
        },
      },
      storage: {
        get: async (key: string) => storage.get(key),
        set: async (key: string, value: unknown) => void storage.set(key, value),
        remove: async (key: string) => void storage.delete(key),
        scan: async ({ prefix }: { prefix: string }) => ({
          entries: [...storage.entries()]
            .filter(([key]) => key.startsWith(prefix))
            .map(([key, value]) => ({ key, value })),
        }),
      },
      session: {
        get: async ({ sessionID }: { sessionID: string }) => sessions.get(sessionID),
        context: async ({ sessionID }: { sessionID: string }) => sessionID === "channel-session" ? [
          { type: "user", text: "The staging repository now has 0.14.0.", time: { created: Date.now() + 1 } },
          {
            type: "assistant",
            content: [{ type: "text", text: "The scribe recorded the staging update." }],
            time: { created: Date.now() + 2 },
          },
        ] : workerContextMessages,
        create: async (input: Record<string, any>) => {
          creates.push(input)
          const session = { id: "worker-session", location: input.location }
          sessions.set(session.id, session)
          return session
        },
        prompt: async (input: Record<string, any>) => {
          prompts.push(input)
          return { id: `inbox-${prompts.length}` }
        },
        synthetic: async (input: Record<string, any>) => {
          synthetics.push(input)
          return { id: `synthetic-${synthetics.length}` }
        },
        generate: async (input: Record<string, any>) => {
          generations.push(input)
          return {
            text: input.prompt.includes("deciding whether proposed follow-up work")
              ? "CONTINUE\nThis is the same release line in the same workspace."
              : "0.14.0 is in staging; verify it before publishing.",
          }
        },
      },
    } as unknown as Context

    await plugin.setup(context)
    expect(skills.get("create-hive").content).toContain("# Create or extend a Hive")
    expect([...tools.keys()]).toEqual([
      "hive_init",
      "hive_status",
      "hive_dispatch",
      "hive_consult_session",
      "hive_recent_status",
      "hive_backfill_details",
      "hive_ask_controller",
      "hive_reply",
      "hive_ack_reply",
      "hive_request_controller",
      "hive_verify_authorization",
      "hive_report",
      "hive_sessions",
    ])

    const channelToolContext = {
      sessionID: "channel-session",
      agent: "build",
      messageID: "channel-message",
      id: "call-init",
      progress: async () => undefined,
    }
    await tools.get("hive_init").execute({}, channelToolContext)
    const dispatchResult = await tools.get("hive_dispatch").execute(
      {
        workspace: "brikk/main",
        request: "Run tests and release if they pass.",
        relevantSummary: "The feature branches are approved, and 0.14.0 may already be staging.",
        memoryItems: ["The target repository is Maven Central staging."],
      },
      { ...channelToolContext, id: "call-dispatch" },
    )

    expect(creates).toHaveLength(1)
    expect(creates[0].agent).toBe("build")
    expect(creates[0].location.directory).toBe(workspaceDirectory)
    expect(prompts).toHaveLength(1)
    expect(prompts[0].sessionID).toBe("worker-session")
    expect(prompts[0].text).toContain("You are working as Hive agent Fooagent")
    expect(prompts[0].text).toContain("The feature branches are approved")
    expect(prompts[0].text).toContain("The target repository is Maven Central staging.")
    expect(prompts[0].text).not.toContain("Recent Hive channel context")
    expect(dispatchResult.content).toContain("worker-session")

    const consultation = await tools.get("hive_consult_session").execute(
      {
        sessionID: "worker-session",
        request: "Verify the staged release and finish publication.",
      },
      { ...channelToolContext, id: "call-consult" },
    )
    expect(generations).toHaveLength(1)
    expect(generations[0].sessionID).toBe("worker-session")
    expect(consultation.content).toContain("CONTINUE")

    const continuation = await tools.get("hive_dispatch").execute(
      {
        mode: "continue",
        sessionID: "worker-session",
        workspace: "brikk/main",
        request: "Verify the staged release and finish publication.",
        relevantSummary: "The staging upload completed after the first dispatch.",
      },
      { ...channelToolContext, id: "call-continue" },
    )
    expect(creates).toHaveLength(1)
    expect(prompts).toHaveLength(2)
    expect(prompts[1].sessionID).toBe("worker-session")
    expect(prompts[1].text).toContain("Continuation from Hive Test Hive")
    expect(continuation.content).toContain("Continued Fooagent")
    expect((storage.get("workers/worker-session") as { dispatchCount: number }).dispatchCount).toBe(2)

    const workerPermission = {
      sessionID: "worker-session",
      action: "shell",
      resources: ["git status"],
      effect: "ask",
    }
    await permissionHook?.(workerPermission)
    expect(workerPermission.effect).toBe("allow")
    const unrelatedPermission = {
      sessionID: "unrelated-session",
      action: "shell",
      resources: ["git status"],
      effect: "ask",
    }
    await permissionHook?.(unrelatedPermission)
    expect(unrelatedPermission.effect).toBe("ask")

    await tools.get("hive_report").execute(
      {
        status: "completed",
        summary: "Tests passed and the release was published.",
        commit: "abc123",
        todos: [],
      },
      {
        sessionID: "worker-session",
        agent: "build",
        messageID: "worker-message",
        id: "call-report",
        progress: async () => undefined,
      },
    )

    expect(prompts).toHaveLength(3)
    expect(prompts[2].sessionID).toBe("channel-session")
    expect(prompts[2].text).toContain("Hive report from Fooagent [completed]")
    expect(prompts[2].text).toContain("Commit: abc123")
    expect(prompts[2].text).not.toContain("\n")
    expect(prompts[2].metadata.sourceSessionID).toBe("worker-session")
    expect(prompts[2].metadata.sourceMessageID).toBe("worker-message")

    const recent = await tools.get("hive_recent_status").execute(
      { limit: 5 },
      {
        sessionID: "worker-session",
        agent: "build",
        messageID: "recent-message",
        id: "call-recent",
        progress: async () => undefined,
      },
    )
    expect(recent.content).toContain("[completed] Fooagent")
    expect(recent.content).toContain("Tests passed and the release was published")

    const backfill = await tools.get("hive_backfill_details").execute(
      { question: "Has 0.14.0 reached staging?" },
      {
        sessionID: "worker-session",
        agent: "build",
        messageID: "backfill-message",
        id: "call-backfill",
        progress: async () => undefined,
      },
    )
    expect(generations).toHaveLength(2)
    expect(generations[1].sessionID).toBe("channel-session")
    expect(generations[1].prompt).toContain("Has 0.14.0 reached staging?")
    expect(generations[1].prompt).toContain("The staging upload completed")
    expect(generations[1].prompt).toContain("Release 0.14.0 after verification")
    expect(generations[1].prompt).toContain("The staging repository now has 0.14.0")
    expect(backfill.content).toContain("0.14.0 is in staging")

    const question = await tools.get("hive_ask_controller").execute(
      { question: "Should I publish the staging repository now?", blocking: true },
      {
        sessionID: "worker-session",
        agent: "build",
        messageID: "question-message",
        id: "call-question",
        progress: async () => undefined,
      },
    )
    expect(question.metadata.questionID).toMatch(/^q_/)
    expect(prompts[3].sessionID).toBe("channel-session")
    expect(prompts[3].text).toContain("Hive question from Fooagent")
    expect(prompts[3].text).not.toContain("\n")

    const duplicateBlocked = await tools.get("hive_report").execute(
      { status: "blocked", summary: "Still waiting for the same answer." },
      {
        sessionID: "worker-session",
        agent: "build",
        messageID: "duplicate-blocked-message",
        id: "call-duplicate-blocked",
        progress: async () => undefined,
      },
    )
    expect(duplicateBlocked.metadata.suppressed).toBe(true)
    expect(prompts).toHaveLength(4)

    await tools.get("hive_reply").execute(
      {
        sessionID: "worker-session",
        questionID: question.metadata.questionID,
        answer: "Yes. Publish after checksum verification.",
      },
      { ...channelToolContext, id: "call-reply" },
    )
    expect(prompts[4].sessionID).toBe("worker-session")
    expect(prompts[4].text).toContain("Yes. Publish after checksum verification.")
    expect(
      (storage.get("workers/worker-session") as { pendingQuestion: { status: string } }).pendingQuestion.status,
    ).toBe("reply-queued")

    await tools.get("hive_ack_reply").execute(
      { questionID: question.metadata.questionID },
      {
        sessionID: "worker-session",
        agent: "build",
        messageID: "ack-message",
        id: "call-ack",
        progress: async () => undefined,
      },
    )
    expect((storage.get("workers/worker-session") as { pendingQuestion?: unknown }).pendingQuestion).toBeUndefined()
    expect(synthetics).toHaveLength(1)
    expect(synthetics[0].resume).toBe(false)
    expect(synthetics[0].text).toContain("Hive reply received by Fooagent")

    const relayed = await tools.get("hive_request_controller").execute(
      { request: "Echo protocol-ok in the Hive channel." },
      {
        sessionID: "worker-session",
        agent: "build",
        messageID: "authorization-tool-message",
        id: "call-authorized-request",
        progress: async () => undefined,
      },
    )
    expect(relayed.metadata.authorizationID).toMatch(/^auth_/)
    expect(prompts[5].sessionID).toBe("channel-session")
    expect(prompts[5].text).toContain("Hive user-authorized request via Fooagent")
    expect(prompts[5].text).toContain("worker-session/worker-direct-user")

    const verified = await tools.get("hive_verify_authorization").execute(
      { authorizationID: relayed.metadata.authorizationID },
      { ...channelToolContext, id: "call-verify-authorization" },
    )
    expect(verified.content).toContain("Verified Hive authorization")
    expect(verified.content).toContain("worker-session/worker-direct-user")

    workerContextMessages.push({
      id: "hive-generated-user",
      type: "user",
      text: "A Hive-generated continuation that does not grant authority.",
      metadata: { hiveID: "test-hive", sourceSessionID: "channel-session" },
      time: { created: Date.now() + 1 },
    })
    await expect(
      tools.get("hive_request_controller").execute(
        { request: "Do something not authorized by the old direct message." },
        {
          sessionID: "worker-session",
          agent: "build",
          messageID: "unauthorized-tool-message",
          id: "call-unauthorized-request",
          progress: async () => undefined,
        },
      ),
    ).rejects.toThrow("not initiated by a direct user message")

    sessions.set("new-channel", { id: "new-channel", location: { directory: hiveDirectory } })
    await expect(
      tools.get("hive_init").execute({}, { ...channelToolContext, sessionID: "new-channel" }),
    ).rejects.toThrow("already registered")
    await tools
      .get("hive_init")
      .execute({ replace: true }, { ...channelToolContext, sessionID: "new-channel" })
    expect((storage.get("channels/test-hive") as { sessionID: string }).sessionID).toBe("new-channel")
    expect(storage.has("channel-sessions/channel-session")).toBe(false)
    expect((storage.get("workers/worker-session") as { channelSessionID: string }).channelSessionID).toBe(
      "new-channel",
    )
    await tools
      .get("hive_init")
      .execute({ replace: true, clearHistory: true }, { ...channelToolContext, sessionID: "new-channel" })
    expect(storage.has("workers/worker-session")).toBe(false)
    expect(
      [...storage.keys()].some(
        (key) =>
          key.startsWith("hives/test-hive/workers/") ||
          key.startsWith("hives/test-hive/reports/") ||
          key.startsWith("hives/test-hive/dispatches/") ||
          key.startsWith("hives/test-hive/authorizations/") ||
          key.startsWith("authorizations/"),
      ),
    ).toBe(false)
  })
})
