import { Plugin } from "@opencode/plugin"
import type { Context } from "@opencode/plugin/promise/plugin"
import type { ToolContext } from "@opencode/plugin/promise/tool"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import {
  assertWorkspaceDirectory,
  configPathsFromOptions,
  discoverHiveConfigPaths,
  loadHiveConfig,
  resolveWorkspace,
  type HiveAgent,
  type HiveConfig,
} from "./config"

interface ChannelRecord {
  hiveID: string
  sessionID: string
  directory: string
  registeredAt?: number
  sourceToolMessageID?: string
  configPath?: string
}

interface WorkerRecord {
  hiveID: string
  sessionID: string
  channelSessionID: string
  channelDirectory: string
  agentName: string
  projectName: string
  workspaceName: string
  workspaceDirectory: string
  dispatchID: string
  createdAt: number
  request?: string
  relevantSummary?: string
  memoryItems?: string[]
  configPath?: string
  permissionMode?: "ask" | "auto"
  lastDispatchAt?: number
  dispatchCount?: number
  lastStatus?: ReportRecord["status"]
  lastReportAt?: number
  pendingQuestion?: {
    id: string
    question: string
    blocking: boolean
    createdAt: number
    status: "awaiting-controller" | "reply-queued"
    replyQueuedAt?: number
  }
  identityState?: "active" | "recovered"
}

interface DispatchRecord {
  hiveID: string
  dispatchID: string
  sessionID: string
  mode: "new" | "continue"
  agentName: string
  projectName: string
  workspaceName: string
  request: string
  relevantSummary?: string
  memoryItems: string[]
  createdAt: number
}

interface HiveBuildInfo {
  version: string
  buildID: string
  builtAt: string
}

interface AuthorizationRecord {
  id: string
  hiveID: string
  request: string
  relayedByAgent: string
  workerSessionID: string
  sourceUserSessionID: string
  sourceUserMessageID: string
  sourceUserText: string
  sourceUserTextHash: string
  createdAt: number
}

interface DetachedWorkerRecord {
  hiveID: string
  sessionID: string
  detachedAt: number
  reason: "clear-history"
}

interface ReportRecord {
  hiveID: string
  agentName: string
  projectName: string
  workspaceName: string
  sessionID: string
  dispatchID: string
  status: "started" | "milestone" | "blocked" | "completed" | "failed"
  summary: string
  commit?: string
  todos: string[]
  createdAt: number
}

const initInput = {
  type: "object",
  properties: {
    hive: { type: "string", description: "Hive ID. Optional when exactly one config is loaded." },
    replace: {
      type: "boolean",
      description: "Replace the registered channel with this session. Use only when intentionally starting fresh.",
    },
    clearHistory: {
      type: "boolean",
      description: "Forget indexed workers and reports without deleting their OpenCode sessions.",
    },
    expectedChannelSessionID: {
      type: "string",
      description: "Current registered channel ID. Required when replacing another channel.",
    },
  },
  additionalProperties: false,
} as const

const reattachWorkerInput = {
  type: "object",
  properties: {
    hive: { type: "string", description: "Hive ID. Usually inferred from the current channel." },
    sessionID: { type: "string", description: "Existing OpenCode session to reattach as a Hive worker." },
    agent: { type: "string", description: "Named Hive agent that owns the session." },
    workspace: { type: "string", description: "Configured workspace that matches the session directory." },
  },
  required: ["sessionID", "agent", "workspace"],
  additionalProperties: false,
} as const

const statusInput = {
  type: "object",
  properties: {
    hive: { type: "string", description: "Hive ID. Optional when exactly one config is loaded." },
  },
  additionalProperties: false,
} as const

const dispatchInput = {
  type: "object",
  properties: {
    hive: { type: "string", description: "Hive ID. Usually inferred from the current channel." },
    agent: { type: "string", description: "Named Hive agent. Uses the workspace default when omitted." },
    workspace: {
      type: "string",
      description: "Workspace reference such as brikk-house/main. Branches and aliases also resolve.",
    },
    request: { type: "string", description: "The work request to send to the worker." },
    mode: {
      type: "string",
      enum: ["new", "continue"],
      description: "Create a new worker or continue an exact existing worker session. Defaults to new.",
    },
    sessionID: {
      type: "string",
      description: "Existing Hive worker session. Required when mode is continue.",
    },
    relevantSummary: {
      type: "string",
      description: "A short coordinator-written summary of facts and context relevant to this request.",
    },
    memoryItems: {
      type: "array",
      items: { type: "string" },
      description: "Small durable facts, decisions, or references that may matter to this work.",
    },
  },
  required: ["workspace", "request"],
  additionalProperties: false,
} as const

const consultSessionInput = {
  type: "object",
  properties: {
    hive: { type: "string", description: "Hive ID. Usually inferred from the current channel." },
    sessionID: { type: "string", description: "Existing Hive worker session to consult." },
    request: { type: "string", description: "Proposed follow-up work." },
    relevantSummary: { type: "string", description: "Optional new context relevant to the proposed work." },
  },
  required: ["sessionID", "request"],
  additionalProperties: false,
} as const

const askControllerInput = {
  type: "object",
  properties: {
    question: { type: "string", description: "Focused question for the Hive controller or user." },
    blocking: { type: "boolean", description: "Whether work is blocked until the answer arrives." },
  },
  required: ["question"],
  additionalProperties: false,
} as const

const replyInput = {
  type: "object",
  properties: {
    hive: { type: "string", description: "Hive ID. Usually inferred from the current channel." },
    sessionID: { type: "string", description: "Hive worker session that asked the question." },
    questionID: { type: "string", description: "Optional question ID shown in the Hive channel." },
    answer: { type: "string", description: "Controller or user answer to send back to the worker." },
  },
  required: ["sessionID", "answer"],
  additionalProperties: false,
} as const

const acknowledgeReplyInput = {
  type: "object",
  properties: {
    questionID: { type: "string", description: "Question ID whose queued controller reply was received." },
  },
  required: ["questionID"],
  additionalProperties: false,
} as const

const requestControllerInput = {
  type: "object",
  properties: {
    request: {
      type: "string",
      description: "Action the user directly instructed this worker to relay to the Hive controller.",
    },
  },
  required: ["request"],
  additionalProperties: false,
} as const

const verifyAuthorizationInput = {
  type: "object",
  properties: {
    hive: { type: "string", description: "Hive ID. Usually inferred from the current channel." },
    authorizationID: { type: "string", description: "Authorization ID attached to the relayed request." },
  },
  required: ["authorizationID"],
  additionalProperties: false,
} as const

const recentStatusInput = {
  type: "object",
  properties: {
    hive: { type: "string", description: "Hive ID. Inferred for Hive channels and workers." },
    limit: { type: "integer", minimum: 1, maximum: 50, description: "Maximum reports. Defaults to 10." },
    agent: { type: "string", description: "Optional Hive agent filter." },
    project: { type: "string", description: "Optional project filter." },
  },
  additionalProperties: false,
} as const

const backfillDetailsInput = {
  type: "object",
  properties: {
    question: {
      type: "string",
      description: "What additional context the worker needs from the Hive.",
    },
  },
  required: ["question"],
  additionalProperties: false,
} as const

const reportInput = {
  type: "object",
  properties: {
    status: {
      type: "string",
      enum: ["started", "milestone", "blocked", "completed", "failed"],
      description: "Worker status at this reporting boundary.",
    },
    summary: { type: "string", description: "Concise report for the Hive channel." },
    commit: { type: "string", description: "Optional commit SHA." },
    todos: { type: "array", items: { type: "string" }, description: "Optional remaining work." },
  },
  required: ["status", "summary"],
  additionalProperties: false,
} as const

const sessionsInput = statusInput

function text(content: string, metadata?: Record<string, unknown>) {
  return { content, metadata }
}

function workerKey(sessionID: string): string {
  return `workers/${sessionID}`
}

function channelKey(hiveID: string): string {
  return `channels/${hiveID}`
}

function sourceChannelKey(sessionID: string): string {
  return `channel-sessions/${sessionID}`
}

function dispatchKey(hiveID: string, dispatchID: string): string {
  return `hives/${hiveID}/dispatches/${dispatchID}`
}

function authorizationKey(authorizationID: string): string {
  return `authorizations/${authorizationID}`
}

function detachedWorkerKey(sessionID: string): string {
  return `detached-workers/${sessionID}`
}

async function saveWorker(ctx: Context, worker: WorkerRecord): Promise<void> {
  await ctx.storage.set(workerKey(worker.sessionID), { ...worker })
  await ctx.storage.set(`hives/${worker.hiveID}/workers/${worker.sessionID}`, { ...worker })
}

async function saveReport(ctx: Context, report: ReportRecord): Promise<void> {
  await ctx.storage.set(`hives/${report.hiveID}/reports/${report.createdAt}-${crypto.randomUUID()}`, {
    ...report,
  })
}

function metadataString(metadata: Readonly<Record<string, unknown>> | undefined, key: string): string | undefined {
  const value = metadata?.[key]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

async function recoverWorker(ctx: Context, sessionID: string): Promise<WorkerRecord> {
  const detached = (await ctx.storage.get(detachedWorkerKey(sessionID))) as DetachedWorkerRecord | undefined
  if (detached) {
    throw new Error(
      `Session ${sessionID} was intentionally detached by clearHistory. Use hive_reattach_worker from the Hive channel to restore it.`,
    )
  }

  const session = await ctx.session.get({ sessionID })
  const metadata = session.metadata as Readonly<Record<string, unknown>> | undefined
  const hiveID = metadataString(metadata, "hiveID")
  const agentName = metadataString(metadata, "hiveAgent")
  const workspaceReference = metadataString(metadata, "hiveWorkspace")
  const dispatchID = metadataString(metadata, "hiveDispatchID")
  if (!hiveID || !agentName || !workspaceReference || !dispatchID) {
    throw new Error("This session has no recoverable Hive worker identity")
  }
  const configPath = metadataString(metadata, "hiveConfigPath")

  let channel = (await ctx.storage.get(channelKey(hiveID))) as ChannelRecord | undefined
  if (!channel) {
    const channelSessionID = metadataString(metadata, "hiveChannelSessionID")
    if (!channelSessionID) throw new Error(`Hive ${hiveID} has no registered channel`)
    const channelSession = await ctx.session.get({ sessionID: channelSessionID })
    channel = {
      hiveID,
      sessionID: channelSessionID,
      directory: channelSession.location.directory,
      configPath,
    }
  }

  let hive: HiveConfig | undefined
  if (configPath) {
    try {
      const candidate = await loadHiveConfig(configPath)
      if (candidate.id === hiveID) hive = candidate
    } catch {
      // Fall through to channel and configured discovery.
    }
  }
  if (!hive && channel.configPath) {
    try {
      const candidate = await loadHiveConfig(channel.configPath)
      if (candidate.id === hiveID) hive = candidate
    } catch {
      // Fall through to local discovery.
    }
  }
  if (!hive) {
    const paths = await discoverHiveConfigPaths(channel.directory, channel.directory)
    if (paths.length === 1) {
      const candidate = await loadHiveConfig(paths[0])
      if (candidate.id === hiveID) hive = candidate
    }
  }
  if (!hive) {
    const candidates = await configuredHives(ctx)
    hive = candidates.find((candidate) => candidate.id === hiveID)
  }
  if (!hive) throw new Error(`Cannot recover ${sessionID}: Hive config ${hiveID} is unavailable`)
  const resolved = resolveWorkspace(hive, workspaceReference)
  if (!hive.agents[agentName]) throw new Error(`Cannot recover ${sessionID}: unknown Hive agent ${agentName}`)
  if (session.location.directory !== resolved.workspace.directory) {
    throw new Error(
      `Cannot recover ${sessionID}: session is in ${session.location.directory}, not ${resolved.workspace.directory}`,
    )
  }
  const dispatches = await ctx.storage.scan({ prefix: `hives/${hiveID}/dispatches/`, limit: 1_000 })
  const matchingDispatches = dispatches.entries
    .map((entry) => entry.value as unknown as DispatchRecord)
    .filter((entry) => entry.sessionID === sessionID)
    .sort((left, right) => right.createdAt - left.createdAt)
  const dispatch = matchingDispatches[0]
  const worker: WorkerRecord = {
    hiveID,
    sessionID,
    channelSessionID: channel.sessionID,
    channelDirectory: channel.directory,
    agentName,
    projectName: resolved.projectName,
    workspaceName: resolved.workspace.name,
    workspaceDirectory: resolved.workspace.directory,
    dispatchID: dispatch?.dispatchID ?? dispatchID,
    createdAt: session.time.created,
    lastDispatchAt: dispatch?.createdAt ?? session.time.created,
    dispatchCount: Math.max(1, matchingDispatches.length),
    request: dispatch?.request,
    relevantSummary: dispatch?.relevantSummary,
    memoryItems: dispatch?.memoryItems ?? [],
    configPath: hive.configPath,
    permissionMode: "ask",
    identityState: "recovered",
  }
  await saveWorker(ctx, worker)
  return worker
}

async function workerForSession(ctx: Context, sessionID: string): Promise<WorkerRecord> {
  const worker = (await ctx.storage.get(workerKey(sessionID))) as WorkerRecord | undefined
  return worker ?? recoverWorker(ctx, sessionID)
}

function modelRef(model: string | undefined): { providerID: string; id: string; variant?: string } | undefined {
  if (!model) return undefined
  const slash = model.indexOf("/")
  if (slash < 1 || slash === model.length - 1) {
    throw new Error(`Agent model must use provider/model format: ${model}`)
  }
  const providerID = model.slice(0, slash)
  const modelAndVariant = model.slice(slash + 1)
  const hash = modelAndVariant.lastIndexOf("#")
  if (hash === -1) return { providerID, id: modelAndVariant }
  return {
    providerID,
    id: modelAndVariant.slice(0, hash),
    variant: modelAndVariant.slice(hash + 1),
  }
}

function openChamberLink(sessionID: string, directory: string): string {
  return `openchamber://session/${sessionID}?dir=${encodeURIComponent(directory)}`
}

function shorten(value: string, length: number): string {
  const line = value.replaceAll(/\s+/g, " ").trim()
  return line.length <= length ? line : `${line.slice(0, length - 1)}…`
}

function oneLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim()
}

function clamp(value: string | undefined, maxCharacters: number): string | undefined {
  if (!value) return undefined
  if (value.length <= maxCharacters) return value
  return `${value.slice(0, maxCharacters - 1)}…`
}

function conversationalText(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined
  const value = message as Record<string, unknown>
  if ((value.type === "user" || value.type === "synthetic") && typeof value.text === "string") {
    return `${value.type === "user" ? "User" : "Log"}: ${value.text}`
  }
  if (value.type === "assistant" && Array.isArray(value.content)) {
    const content = value.content
      .filter(
        (part): part is { type: "text"; text: string } =>
          !!part &&
          typeof part === "object" &&
          (part as Record<string, unknown>).type === "text" &&
          typeof (part as Record<string, unknown>).text === "string",
      )
      .map((part) => part.text)
      .join("\n")
    return content ? `Assistant: ${content}` : undefined
  }
  return undefined
}

function messageCreatedAt(message: unknown): number | undefined {
  if (!message || typeof message !== "object") return undefined
  const time = (message as Record<string, unknown>).time
  if (!time || typeof time !== "object") return undefined
  const created = (time as Record<string, unknown>).created
  return typeof created === "number" ? created : undefined
}

function messageID(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined
  const id = (message as Record<string, unknown>).id
  return typeof id === "string" ? id : undefined
}

function isDirectUserMessage(message: unknown): message is {
  id: string
  text: string
  metadata?: Record<string, unknown>
} {
  if (!message || typeof message !== "object") return false
  const value = message as Record<string, unknown>
  if (value.type !== "user" || typeof value.id !== "string" || typeof value.text !== "string") return false
  const metadata = value.metadata
  if (!metadata || typeof metadata !== "object") return true
  const fields = metadata as Record<string, unknown>
  return !(
    fields.hiveID ||
    fields.hiveDispatchID ||
    fields.sourceSessionID ||
    fields.authorizationID ||
    fields.questionID
  )
}

function isUserMessage(message: unknown): boolean {
  return !!message && typeof message === "object" && (message as Record<string, unknown>).type === "user"
}

async function initiatingDirectUserMessage(ctx: Context, tool: ToolContext) {
  const messages = await ctx.session.context({ sessionID: tool.sessionID })
  const assistantIndex = messages.findIndex((message) => messageID(message) === tool.messageID)
  const beforeTool = assistantIndex === -1 ? messages : messages.slice(0, assistantIndex)
  const source = [...beforeTool].reverse().find(isUserMessage)
  if (!isDirectUserMessage(source)) {
    throw new Error(
      "The current worker turn was not initiated by a direct user message. Ask the user in this worker session or ask the Hive controller to obtain confirmation.",
    )
  }
  return source
}

async function channelUpdates(
  ctx: Context,
  record: WorkerRecord,
  messageCount: number,
): Promise<string | undefined> {
  if (messageCount === 0) return undefined
  const messages = await ctx.session.context({ sessionID: record.channelSessionID })
  const since = record.lastDispatchAt ?? record.createdAt
  const selected = messages
    .filter((message) => (messageCreatedAt(message) ?? 0) > since)
    .map(conversationalText)
    .filter((message): message is string => !!message)
    .slice(-messageCount)
  if (selected.length === 0) return undefined
  return clamp(selected.join("\n\n"), 16_000)
}

async function hiveMarkdown(config: HiveConfig): Promise<string | undefined> {
  const names = ["MEMORY.md", "PLAN.md", "TODO.md", "PROGRESS.md"]
  const sections: string[] = []
  for (const name of names) {
    const file = Bun.file(`${config.directory}/${name}`)
    if (!(await file.exists())) continue
    const content = clamp(await file.text(), 6_000)
    if (content) sections.push(`## ${name}\n${content}`)
  }
  return clamp(sections.join("\n\n"), 18_000)
}

async function relatedReports(ctx: Context, record: WorkerRecord): Promise<string | undefined> {
  const page = await ctx.storage.scan({ prefix: `hives/${record.hiveID}/reports/`, limit: 1_000 })
  const reports = page.entries
    .map((entry) => entry.value as unknown as ReportRecord)
    .filter(
      (report) =>
        report.sessionID !== record.sessionID &&
        (report.projectName === record.projectName || report.agentName === record.agentName),
    )
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, 8)
  if (reports.length === 0) return undefined
  return reports
    .map(
      (report) =>
        `[${report.status}] ${report.agentName} in ${report.projectName}/${report.workspaceName}: ${report.summary}${
          report.commit ? ` (commit ${report.commit})` : ""
        }\nSource session: ${report.sessionID}`,
    )
    .join("\n\n")
}

async function relatedSessionSummaries(ctx: Context, record: WorkerRecord): Promise<string | undefined> {
  const page = await ctx.storage.scan({ prefix: `hives/${record.hiveID}/workers/`, limit: 1_000 })
  const related = page.entries
    .map((entry) => entry.value as unknown as WorkerRecord)
    .filter(
      (worker) =>
        worker.sessionID !== record.sessionID &&
        (worker.projectName === record.projectName || worker.agentName === record.agentName),
    )
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, 3)

  const summaries: string[] = []
  for (const worker of related) {
    try {
      const messages = await ctx.session.context({ sessionID: worker.sessionID })
      const summary = messages.map(conversationalText).filter((value): value is string => !!value).at(-1)
      if (!summary) continue
      summaries.push(
        `${worker.agentName} in ${worker.projectName}/${worker.workspaceName}:\n${clamp(summary, 3_000)}\nSource session: ${worker.sessionID}`,
      )
    } catch {
      // A missing or archived related session should not prevent a backfill.
    }
  }
  return summaries.length ? summaries.join("\n\n") : undefined
}

async function hiveForWorker(ctx: Context, worker: WorkerRecord): Promise<HiveConfig> {
  if (worker.configPath) {
    try {
      return await loadHiveConfig(worker.configPath)
    } catch {
      // Fall back to configured discovery for records created before config paths were stored or after a move.
    }
  }
  const hives = await configuredHives(ctx)
  const hive = hives.find((candidate) => candidate.id === worker.hiveID)
  if (!hive) throw new Error(`Hive config is unavailable: ${worker.hiveID}`)
  return hive
}

async function controllerHive(
  ctx: Context,
  sessionID: string,
  requested?: string,
): Promise<{ hive: HiveConfig; channel: ChannelRecord }> {
  const hives = await configuredHives(ctx)
  const hive = await selectHive(ctx, hives, sessionID, requested)
  const channel = (await ctx.storage.get(channelKey(hive.id))) as ChannelRecord | undefined
  if (!channel) throw new Error(`Run hive_init before coordinating work for ${hive.id}`)
  if (channel.sessionID !== sessionID) throw new Error(`Only the registered Hive channel may do this for ${hive.id}`)
  return { hive, channel }
}

function dispatchPrompt(input: {
  config: HiveConfig
  agentName: string
  agent: HiveAgent
  projectName: string
  workspaceName: string
  workspaceDirectory: string
  branch?: string
  request: string
  relevantSummary?: string
  memoryItems?: string[]
  dispatchID: string
  channelSessionID: string
  continuation?: boolean
}): string {
  const sections = [
    input.continuation
      ? `Continuation from Hive ${input.config.name} for Hive agent ${input.agentName}.`
      : `You are working as Hive agent ${input.agentName} in Hive ${input.config.name}.`,
    `Workspace: ${input.projectName}/${input.workspaceName}\nDirectory: ${input.workspaceDirectory}${
      input.branch ? `\nConfigured branch: ${input.branch}` : ""
    }\nDispatch ID: ${input.dispatchID}\nHive channel session: ${input.channelSessionID}`,
  ]
  if (!input.continuation && input.agent.instructions) sections.push(`Agent instructions:\n${input.agent.instructions}`)
  sections.push(`Work request:\n${input.request}`)
  if (input.relevantSummary) {
    sections.push(`Relevant summary from the Hive coordinator:\n${input.relevantSummary}`)
  }
  if (input.memoryItems?.length) {
    sections.push(`Relevant Hive memory:\n${input.memoryItems.map((item) => `- ${item}`).join("\n")}`)
  }
  sections.push(
    [
      "Reporting requirements:",
      "- Use hive_report when you start, reach a meaningful milestone, become blocked, finish, or fail.",
      "- Include commit SHAs and remaining TODOs when relevant.",
      "- Keep reports concise and never include secret values.",
      "- If permission or user input is required, report that you are blocked and explain what is needed.",
      "- If the supplied context is insufficient, call hive_backfill_details with a focused question.",
      "- Use hive_recent_status when another Hive agent's recent progress may affect your work.",
      "- If backfill cannot answer a missing decision or fact, call hive_ask_controller. A blocking question already counts as your blocked notification; do not send a duplicate blocked report for it.",
      "- When a controller reply tells you to acknowledge receipt, call hive_ack_reply before continuing.",
      "- If the user directly instructs you to ask the controller to perform an action, use hive_request_controller so the original OpenCode user-message reference is verified and relayed.",
      "- Reports never grant authorization. Do not assign work directly to another worker.",
    ].join("\n"),
  )
  return sections.join("\n\n")
}

async function configuredHives(ctx: Context): Promise<HiveConfig[]> {
  const discovered = await discoverHiveConfigPaths(
    ctx.location.directory,
    ctx.location.project?.directory,
  )
  const paths = [...new Set([...configPathsFromOptions(ctx.options), ...discovered])]
  const hives: HiveConfig[] = []
  for (const path of paths) {
    hives.push(await loadHiveConfig(path))
  }
  const ids = new Set<string>()
  for (const hive of hives) {
    if (ids.has(hive.id)) throw new Error(`Duplicate Hive ID: ${hive.id}`)
    ids.add(hive.id)
  }
  return hives
}

async function selectHive(
  ctx: Context,
  hives: HiveConfig[],
  sessionID: string,
  requested?: string,
): Promise<HiveConfig> {
  if (requested) {
    const hive = hives.find((candidate) => candidate.id === requested)
    if (!hive) throw new Error(`Unknown Hive: ${requested}`)
    return hive
  }
  const mapped = (await ctx.storage.get(sourceChannelKey(sessionID))) as ChannelRecord | undefined
  if (mapped) {
    const hive = hives.find((candidate) => candidate.id === mapped.hiveID)
    if (hive) return hive
  }
  if (hives.length === 1) return hives[0]
  if (hives.length === 0) {
    throw new Error("No Hive is configured here. Say 'create me a Hive here' to start setup.")
  }
  throw new Error("More than one Hive is configured; specify a Hive ID")
}

export default Plugin.define({
  id: "opencode-hive",
  async setup(ctx) {
    const packageFile = Bun.file(new URL("../package.json", import.meta.url))
    const packageInfo = (await packageFile.json()) as { version: string }
    const buildFile = Bun.file(new URL("./build-info.json", import.meta.url))
    const buildInfo: HiveBuildInfo = (await buildFile.exists())
      ? ((await buildFile.json()) as HiveBuildInfo)
      : { version: packageInfo.version, buildID: "source-dev", builtAt: "not built" }

    await ctx.permission.hook("evaluate", async (event) => {
      if (event.effect !== "ask") return
      const worker = (await ctx.storage.get(workerKey(event.sessionID))) as WorkerRecord | undefined
      if (worker?.permissionMode !== "auto") return
      event.effect = "allow"
      event.message = `Auto-approved by Hive ${worker.hiveID} for ${worker.agentName}`
    })

    const createHiveSkillLocation = fileURLToPath(new URL("../skills/create-hive/SKILL.md", import.meta.url))
    const createHiveSkillSource = await Bun.file(createHiveSkillLocation).text()
    const createHiveSkillContent = createHiveSkillSource.replace(/^---\n[\s\S]*?\n---\n+/, "")
    await ctx.skill.transform((editor) => {
      const skill = {
        id: "create-hive",
        name: "Create Hive",
        description:
          "Create or extend an OpenCode Hive through conversation, with project, Git worktree, model, and agent discovery.",
        slash: true,
        location: createHiveSkillLocation,
        content: createHiveSkillContent,
      }
      editor.add(skill as unknown as Parameters<typeof editor.add>[0])
    })

    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "hive",
        description: "Dispatch named Hive agents to configured workspaces and report their progress.",
      })

      editor.add({
        name: "init",
        description: "Register the current OpenCode session as a Hive's coordination and progress channel.",
        input: initInput,
        options: { namespace: "hive" },
        execute: async (rawInput: unknown, tool: ToolContext) => {
          const input = rawInput as {
            hive?: string
            replace?: boolean
            clearHistory?: boolean
            expectedChannelSessionID?: string
          }
          const hives = await configuredHives(ctx)
          const hive = await selectHive(ctx, hives, tool.sessionID, input.hive)
          const session = await ctx.session.get({ sessionID: tool.sessionID })
          const previous = (await ctx.storage.get(channelKey(hive.id))) as ChannelRecord | undefined
          if (previous && previous.sessionID !== tool.sessionID && !input.replace) {
            throw new Error(`Hive ${hive.id} is already registered to session ${previous.sessionID}`)
          }
          if (
            previous &&
            previous.sessionID !== tool.sessionID &&
            input.replace &&
            input.expectedChannelSessionID !== previous.sessionID
          ) {
            throw new Error(
              `Channel replacement conflict: expected ${previous.sessionID}. Pass expectedChannelSessionID with the current channel ID.`,
            )
          }
          const record: ChannelRecord = {
            hiveID: hive.id,
            sessionID: tool.sessionID,
            directory: session.location.directory,
            registeredAt: Date.now(),
            sourceToolMessageID: tool.messageID,
            configPath: hive.configPath,
          }
          if (previous && previous.sessionID !== tool.sessionID) {
            await ctx.storage.remove(sourceChannelKey(previous.sessionID))
          }
          if (input.replace) {
            const workers = await ctx.storage.scan({ prefix: `hives/${hive.id}/workers/`, limit: 1_000 })
            for (const entry of workers.entries) {
              const worker = entry.value as unknown as WorkerRecord
              const updated = {
                ...worker,
                channelSessionID: tool.sessionID,
                channelDirectory: session.location.directory,
              }
              await ctx.storage.set(entry.key, updated)
              await ctx.storage.set(workerKey(worker.sessionID), updated)
            }
          }
          if (input.clearHistory) {
            const workers = await ctx.storage.scan({ prefix: `hives/${hive.id}/workers/`, limit: 1_000 })
            for (const entry of workers.entries) {
              const worker = entry.value as unknown as WorkerRecord
              const detached: DetachedWorkerRecord = {
                hiveID: hive.id,
                sessionID: worker.sessionID,
                detachedAt: Date.now(),
                reason: "clear-history",
              }
              await ctx.storage.set(detachedWorkerKey(worker.sessionID), { ...detached })
              await ctx.storage.set(`hives/${hive.id}/detached/${worker.sessionID}`, { ...detached })
              await ctx.storage.remove(entry.key)
              await ctx.storage.remove(workerKey(worker.sessionID))
            }
            const reports = await ctx.storage.scan({ prefix: `hives/${hive.id}/reports/`, limit: 1_000 })
            for (const entry of reports.entries) await ctx.storage.remove(entry.key)
            const dispatches = await ctx.storage.scan({ prefix: `hives/${hive.id}/dispatches/`, limit: 1_000 })
            for (const entry of dispatches.entries) await ctx.storage.remove(entry.key)
            const authorizations = await ctx.storage.scan({
              prefix: `hives/${hive.id}/authorizations/`,
              limit: 1_000,
            })
            for (const entry of authorizations.entries) {
              const authorization = entry.value as unknown as AuthorizationRecord
              await ctx.storage.remove(entry.key)
              await ctx.storage.remove(authorizationKey(authorization.id))
            }
          }
          await ctx.storage.set(channelKey(hive.id), { ...record })
          await ctx.storage.set(sourceChannelKey(tool.sessionID), { ...record })
          await ctx.storage.set(`hives/${hive.id}/channels/${record.registeredAt}-${tool.sessionID}`, {
            ...record,
            previousSessionID: previous?.sessionID ?? null,
          })
          return text(`Registered ${hive.name} channel.\nSession: ${tool.sessionID}`)
        },
      })

      editor.add({
        name: "status",
        description: "Show a Hive's configured agents, workspaces, channel, and worker count.",
        input: statusInput,
        options: { namespace: "hive" },
        execute: async (rawInput: unknown, tool: ToolContext) => {
          const input = rawInput as { hive?: string }
          const hives = await configuredHives(ctx)
          const hive = await selectHive(ctx, hives, tool.sessionID, input.hive)
          const channel = (await ctx.storage.get(channelKey(hive.id))) as ChannelRecord | undefined
          const workers = await ctx.storage.scan({ prefix: "workers/", limit: 1_000 })
          const hiveWorkers = workers.entries
            .map((entry) => entry.value as unknown as WorkerRecord)
            .filter((worker) => worker.hiveID === hive.id)
          const workerCount = hiveWorkers.length
          const pendingQuestions = hiveWorkers.filter(
            (worker) => worker.pendingQuestion?.status === "awaiting-controller",
          ).length
          const queuedReplies = hiveWorkers.filter(
            (worker) => worker.pendingQuestion?.status === "reply-queued",
          ).length
          const recoveredWorkers = hiveWorkers.filter((worker) => worker.identityState === "recovered").length
          const detachedWorkers = await ctx.storage.scan({ prefix: `hives/${hive.id}/detached/`, limit: 1_000 })
          const workspaces = Object.entries(hive.projects).flatMap(([project, definition]) =>
            definition.workspaces.map(
              (workspace) =>
                `- ${project}/${workspace.name}: ${workspace.directory} -> ${
                  workspace.defaultAgent ?? "no default agent"
                }`,
            ),
          )
          return text(
            [
              `${hive.name} (${hive.id})`,
              `Hive plugin: ${buildInfo.version} (${buildInfo.buildID}, built ${buildInfo.builtAt})`,
              `OpenCode: ${ctx.app.name} ${ctx.app.version} (${ctx.app.channel}), server pid ${process.pid}`,
              `Channel: ${channel?.sessionID ?? "not registered"}`,
              channel?.registeredAt
                ? `Channel registered: ${new Date(channel.registeredAt).toISOString()}`
                : "Channel registered: unknown",
              `Agents: ${Object.keys(hive.agents).join(", ")}`,
              `Workers: ${workerCount}`,
              `Recovered workers awaiting reattach or continuation: ${recoveredWorkers}`,
              `Detached workers: ${detachedWorkers.entries.length}`,
              `Questions awaiting controller: ${pendingQuestions}`,
              `Replies awaiting worker receipt: ${queuedReplies}`,
              "Workspaces:",
              ...workspaces,
            ].join("\n"),
          )
        },
      })

      editor.add({
        name: "reattach_worker",
        description:
          "Explicitly restore an existing OpenCode session as a Hive worker after a reset or missing mapping. The session directory, Hive metadata, agent, and workspace are validated.",
        input: reattachWorkerInput,
        options: { namespace: "hive" },
        execute: async (rawInput: unknown, tool: ToolContext) => {
          const input = rawInput as { hive?: string; sessionID: string; agent: string; workspace: string }
          const { hive, channel } = await controllerHive(ctx, tool.sessionID, input.hive)
          const existing = (await ctx.storage.get(workerKey(input.sessionID))) as WorkerRecord | undefined
          if (existing) {
            if (existing.hiveID !== hive.id) throw new Error(`${input.sessionID} belongs to Hive ${existing.hiveID}`)
            if (existing.identityState !== "recovered") {
              return text(`Session ${input.sessionID} is already attached to ${hive.name}.`)
            }
          }
          const agent = hive.agents[input.agent]
          if (!agent) throw new Error(`Unknown Hive agent: ${input.agent}`)
          const resolved = resolveWorkspace(hive, input.workspace)
          await assertWorkspaceDirectory(resolved.workspace)
          const session = await ctx.session.get({ sessionID: input.sessionID })
          if (session.location.directory !== resolved.workspace.directory) {
            throw new Error(
              `${input.sessionID} is in ${session.location.directory}, not ${resolved.workspace.directory}`,
            )
          }
          const metadata = session.metadata as Readonly<Record<string, unknown>> | undefined
          const metadataHiveID = metadataString(metadata, "hiveID")
          if (metadataHiveID && metadataHiveID !== hive.id) {
            throw new Error(`${input.sessionID} has metadata for Hive ${metadataHiveID}`)
          }
          const dispatchID = metadataString(metadata, "hiveDispatchID") ?? `reattach_${crypto.randomUUID()}`
          const worker: WorkerRecord = {
            hiveID: hive.id,
            sessionID: session.id,
            channelSessionID: channel.sessionID,
            channelDirectory: channel.directory,
            agentName: input.agent,
            projectName: resolved.projectName,
            workspaceName: resolved.workspace.name,
            workspaceDirectory: resolved.workspace.directory,
            dispatchID,
            createdAt: session.time.created,
            lastDispatchAt: session.time.updated,
            dispatchCount: 1,
            request: "Session explicitly reattached by the Hive controller.",
            memoryItems: [],
            configPath: hive.configPath,
            permissionMode:
              resolved.workspace.permissionMode ?? agent.permissionMode ?? hive.permissionMode,
            identityState: "active",
          }
          await saveWorker(ctx, worker)
          await ctx.storage.remove(detachedWorkerKey(session.id))
          await ctx.storage.remove(`hives/${hive.id}/detached/${session.id}`)
          await ctx.session.synthetic({
            sessionID: session.id,
            text: `Reattached to Hive ${hive.name} as ${input.agent} in ${resolved.reference}.`,
            description: "Hive worker reattached",
            resume: false,
            metadata: {
              hiveID: hive.id,
              hiveAgent: input.agent,
              hiveWorkspace: resolved.reference,
              hiveChannelSessionID: channel.sessionID,
              sourceSessionID: tool.sessionID,
            },
          })
          return text(
            `Reattached ${input.agent} in ${resolved.reference}.\nSession: ${session.id}\nOpen: ${openChamberLink(
              session.id,
              resolved.workspace.directory,
            )}`,
          )
        },
      })

      editor.add({
        name: "dispatch",
        description: "Create a worker session for a named Hive agent in a configured workspace and send it work.",
        input: dispatchInput,
        options: { namespace: "hive" },
        execute: async (
          rawInput: unknown,
          tool: ToolContext,
        ) => {
          const input = rawInput as {
            hive?: string
            agent?: string
            workspace: string
            request: string
            mode?: "new" | "continue"
            sessionID?: string
            relevantSummary?: string
            memoryItems?: string[]
          }
          const mode = input.mode ?? "new"
          if (mode === "new" && input.sessionID) throw new Error("sessionID is only valid when mode is continue")
          if (mode === "continue" && !input.sessionID) throw new Error("mode continue requires sessionID")
          const { hive, channel } = await controllerHive(ctx, tool.sessionID, input.hive)

          const resolved = resolveWorkspace(hive, input.workspace)
          await assertWorkspaceDirectory(resolved.workspace)
          const previous = input.sessionID
            ? await workerForSession(ctx, input.sessionID)
            : undefined
          if (mode === "continue" && !previous) throw new Error(`Unknown Hive worker session: ${input.sessionID}`)
          const agentName = input.agent ?? previous?.agentName ?? resolved.workspace.defaultAgent
          if (!agentName) throw new Error(`${resolved.reference} has no default agent; specify an agent`)
          const agent = hive.agents[agentName]
          if (!agent) throw new Error(`Unknown Hive agent: ${agentName}`)
          if (previous) {
            if (previous.hiveID !== hive.id) throw new Error(`${previous.sessionID} belongs to Hive ${previous.hiveID}`)
            if (previous.agentName !== agentName) {
              throw new Error(`${previous.sessionID} belongs to Hive agent ${previous.agentName}, not ${agentName}`)
            }
            if (
              previous.projectName !== resolved.projectName ||
              previous.workspaceName !== resolved.workspace.name
            ) {
              throw new Error(
                `${previous.sessionID} belongs to ${previous.projectName}/${previous.workspaceName}, not ${resolved.reference}`,
              )
            }
          }

          const dispatchID = crypto.randomUUID()
          const dispatchedAt = Date.now()
          const permissionMode = resolved.workspace.permissionMode ?? agent.permissionMode ?? hive.permissionMode
          const session = previous
            ? await ctx.session.get({ sessionID: previous.sessionID })
            : await ctx.session.create({
                title: `${agentName}: ${shorten(input.request, 72)}`,
                agent: agent.openCodeAgent,
                model: modelRef(agent.model),
                location: { directory: resolved.workspace.directory },
                metadata: {
                  hiveID: hive.id,
                  hiveAgent: agentName,
                  hiveWorkspace: resolved.reference,
                  hiveDispatchID: dispatchID,
                  hiveChannelSessionID: tool.sessionID,
                  hiveChannelDirectory: channel.directory,
                  hiveConfigPath: hive.configPath,
                  hivePermissionMode: permissionMode,
                },
              })
          if (session.location.directory !== resolved.workspace.directory) {
            throw new Error(
              `${session.id} is currently in ${session.location.directory}, not ${resolved.workspace.directory}`,
            )
          }
          const record: WorkerRecord = previous
            ? {
                ...previous,
                channelSessionID: tool.sessionID,
                channelDirectory: channel.directory,
                dispatchID,
                request: input.request,
                relevantSummary: input.relevantSummary,
                memoryItems: input.memoryItems ?? [],
                configPath: hive.configPath,
                permissionMode,
                identityState: "active",
                lastDispatchAt: dispatchedAt,
                dispatchCount: (previous.dispatchCount ?? 1) + 1,
                pendingQuestion: undefined,
              }
            : {
                hiveID: hive.id,
                sessionID: session.id,
                channelSessionID: tool.sessionID,
                channelDirectory: channel.directory,
                agentName,
                projectName: resolved.projectName,
                workspaceName: resolved.workspace.name,
                workspaceDirectory: resolved.workspace.directory,
                dispatchID,
                createdAt: dispatchedAt,
                lastDispatchAt: dispatchedAt,
                dispatchCount: 1,
                request: input.request,
                relevantSummary: input.relevantSummary,
                memoryItems: input.memoryItems ?? [],
                configPath: hive.configPath,
                permissionMode,
                identityState: "active",
              }
          const dispatch: DispatchRecord = {
            hiveID: hive.id,
            dispatchID,
            sessionID: session.id,
            mode,
            agentName,
            projectName: resolved.projectName,
            workspaceName: resolved.workspace.name,
            request: input.request,
            relevantSummary: input.relevantSummary,
            memoryItems: input.memoryItems ?? [],
            createdAt: dispatchedAt,
          }
          await saveWorker(ctx, record)
          await ctx.storage.set(dispatchKey(hive.id, dispatchID), { ...dispatch })

          try {
            await ctx.session.prompt({
              sessionID: session.id,
              text: dispatchPrompt({
                config: hive,
                agentName,
                agent,
                projectName: resolved.projectName,
                workspaceName: resolved.workspace.name,
                workspaceDirectory: resolved.workspace.directory,
                branch: resolved.workspace.branch,
                request: input.request,
                relevantSummary: input.relevantSummary,
                memoryItems: input.memoryItems,
                dispatchID,
                channelSessionID: tool.sessionID,
                continuation: mode === "continue",
              }),
              delivery: "queue",
              metadata: {
                hiveID: hive.id,
                hiveAgent: agentName,
                hiveDispatchID: dispatchID,
                hiveDispatchMode: mode,
                sourceSessionID: tool.sessionID,
              },
            })
          } catch (error) {
            await ctx.storage.remove(dispatchKey(hive.id, dispatchID))
            if (previous) await saveWorker(ctx, previous)
            else {
              await ctx.storage.remove(workerKey(session.id))
              await ctx.storage.remove(`hives/${hive.id}/workers/${session.id}`)
            }
            throw error
          }

          return text(
            [
              `${mode === "continue" ? "Continued" : "Dispatched"} ${agentName} in ${resolved.reference}.`,
              `Worker session: ${session.id}`,
              `Open: ${openChamberLink(session.id, resolved.workspace.directory)}`,
            ].join("\n"),
            { hiveID: hive.id, dispatchID, dispatchMode: mode, workerSessionID: session.id },
          )
        },
      })

      editor.add({
        name: "consult_session",
        description:
          "Ask an existing Hive worker session whether proposed follow-up work belongs in its current context. This is advisory and does not mutate the worker transcript.",
        input: consultSessionInput,
        options: { namespace: "hive" },
        execute: async (rawInput: unknown, tool: ToolContext) => {
          const input = rawInput as {
            hive?: string
            sessionID: string
            request: string
            relevantSummary?: string
          }
          const { hive } = await controllerHive(ctx, tool.sessionID, input.hive)
          const worker = await workerForSession(ctx, input.sessionID)
          if (worker.hiveID !== hive.id) throw new Error(`${input.sessionID} belongs to Hive ${worker.hiveID}`)
          await ctx.session.get({ sessionID: worker.sessionID })
          const recommendation = await ctx.session.generate({
            sessionID: worker.sessionID,
            prompt: [
              "The Hive controller is deciding whether proposed follow-up work belongs in this existing session.",
              "Do not perform the work. Reply with CONTINUE, NEW, or UNCLEAR on the first line, followed by one short reason.",
              `Current Hive identity: ${worker.agentName} in ${worker.projectName}/${worker.workspaceName}`,
              worker.request ? `Most recent request:\n${worker.request}` : undefined,
              `Proposed follow-up:\n${input.request}`,
              input.relevantSummary ? `New relevant context:\n${input.relevantSummary}` : undefined,
            ]
              .filter((value): value is string => !!value)
              .join("\n\n"),
          })
          return text(
            [
              `Consulted ${worker.agentName} in ${worker.projectName}/${worker.workspaceName}:`,
              recommendation.text,
              `Session: ${openChamberLink(worker.sessionID, worker.workspaceDirectory)}`,
            ].join("\n\n"),
            { hiveID: hive.id, workerSessionID: worker.sessionID },
          )
        },
      })

      editor.add({
        name: "recent_status",
        description:
          "List the most recent reports in the caller's Hive. Controllers and workers can filter by agent or project before coordinating related work.",
        input: recentStatusInput,
        options: { namespace: "hive" },
        execute: async (rawInput: unknown, tool: ToolContext) => {
          const input = rawInput as { hive?: string; limit?: number; agent?: string; project?: string }
          const caller = await workerForSession(ctx, tool.sessionID).catch(() => undefined)
          let hive: HiveConfig
          if (caller) {
            if (input.hive && input.hive !== caller.hiveID) {
              throw new Error(`Worker ${tool.sessionID} belongs to Hive ${caller.hiveID}`)
            }
            hive = await hiveForWorker(ctx, caller)
          } else {
            hive = (await controllerHive(ctx, tool.sessionID, input.hive)).hive
          }
          const limit = input.limit ?? 10
          if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("limit must be from 1 to 50")
          const page = await ctx.storage.scan({ prefix: `hives/${hive.id}/reports/`, limit: 1_000 })
          const reports = page.entries
            .map((entry) => entry.value as unknown as ReportRecord)
            .filter((report) => !input.agent || report.agentName === input.agent)
            .filter((report) => !input.project || report.projectName === input.project)
            .sort((left, right) => right.createdAt - left.createdAt)
            .slice(0, limit)
          if (reports.length === 0) return text(`No matching reports in ${hive.name}.`)
          const lines: string[] = []
          for (const report of reports) {
            const worker = (await ctx.storage.get(workerKey(report.sessionID))) as WorkerRecord | undefined
            lines.push(
              [
                `${new Date(report.createdAt).toISOString()} [${report.status}] ${report.agentName}`,
                `${report.projectName}/${report.workspaceName}: ${oneLine(report.summary)}`,
                report.commit ? `Commit: ${oneLine(report.commit)}` : undefined,
                worker
                  ? `Open: ${openChamberLink(report.sessionID, worker.workspaceDirectory)}`
                  : `Session: ${report.sessionID}`,
              ]
                .filter((value): value is string => !!value)
                .join(" | "),
            )
          }
          return text(lines.join("\n"), { hiveID: hive.id, reportCount: reports.length })
        },
      })

      editor.add({
        name: "backfill_details",
        description:
          "Ask the Hive for missing context. Returns a focused answer using the dispatch, memory, recent updates, reports, and related sessions without waking the Hive channel.",
        input: backfillDetailsInput,
        options: { namespace: "hive" },
        execute: async (rawInput: unknown, tool: ToolContext) => {
          const input = rawInput as { question: string }
          const record = await workerForSession(ctx, tool.sessionID)
          const hive = await hiveForWorker(ctx, record)

          const [updates, markdown, reports, sessions] = await Promise.all([
            channelUpdates(ctx, record, hive.channel.contextMessages),
            hiveMarkdown(hive),
            relatedReports(ctx, record),
            relatedSessionSummaries(ctx, record),
          ])
          const evidence = [
            `Question from ${record.agentName} in ${record.projectName}/${record.workspaceName}:\n${input.question}`,
            record.request ? `Original work request:\n${clamp(record.request, 6_000)}` : undefined,
            record.relevantSummary
              ? `Coordinator's relevant summary:\n${clamp(record.relevantSummary, 8_000)}`
              : undefined,
            record.memoryItems?.length
              ? `Memory items supplied at dispatch:\n${record.memoryItems
                  .map((item) => `- ${clamp(item, 2_000)}`)
                  .join("\n")}`
              : undefined,
            updates ? `Hive channel updates since dispatch:\n${updates}` : undefined,
            reports ? `Related worker reports:\n${reports}` : undefined,
            sessions ? `Recent related session summaries:\n${sessions}` : undefined,
            markdown ? `Current Hive Markdown:\n${markdown}` : undefined,
          ].filter((section): section is string => !!section)

          const generated = await ctx.session.generate({
            sessionID: record.channelSessionID,
            prompt: [
              "Answer a Hive worker's context backfill question.",
              "Use only the supplied evidence and the Hive channel context. Say when the evidence is uncertain or missing.",
              "Give a concise operational answer. Include source session IDs when they help the worker inspect details.",
              ...evidence,
            ].join("\n\n"),
          })
          return text(
            [
              `Hive backfill for ${record.projectName}/${record.workspaceName}:`,
              generated.text,
              `Hive channel: ${openChamberLink(record.channelSessionID, record.channelDirectory)}`,
            ].join("\n\n"),
            {
              hiveID: record.hiveID,
              dispatchID: record.dispatchID,
              channelSessionID: record.channelSessionID,
            },
          )
        },
      })

      editor.add({
        name: "ask_controller",
        description:
          "Ask the Hive controller or user for a missing decision or fact. Use context backfill first when the answer may already exist in Hive history.",
        input: askControllerInput,
        options: { namespace: "hive" },
        execute: async (rawInput: unknown, tool: ToolContext) => {
          const input = rawInput as { question: string; blocking?: boolean }
          const worker = await workerForSession(ctx, tool.sessionID)
          if (worker.pendingQuestion) {
            throw new Error(`Question ${worker.pendingQuestion.id} is still awaiting a controller reply`)
          }
          const question = {
            id: `q_${crypto.randomUUID().slice(0, 8)}`,
            question: oneLine(input.question),
            blocking: input.blocking ?? false,
            createdAt: Date.now(),
            status: "awaiting-controller" as const,
          }
          const updated = {
            ...worker,
            pendingQuestion: question,
            ...(question.blocking ? { lastStatus: "blocked" as const, lastReportAt: question.createdAt } : {}),
          }
          await saveWorker(ctx, updated)
          try {
            await ctx.session.prompt({
              sessionID: worker.channelSessionID,
              text: [
                `Hive question from ${worker.agentName} [${question.id}${question.blocking ? ", blocking" : ""}]`,
                `${worker.projectName}/${worker.workspaceName}: ${question.question}`,
                `Open: ${openChamberLink(worker.sessionID, worker.workspaceDirectory)}`,
              ].join(" | "),
              delivery: "queue",
              metadata: {
                hiveID: worker.hiveID,
                hiveAgent: worker.agentName,
                hiveDispatchID: worker.dispatchID,
                sourceSessionID: worker.sessionID,
                sourceMessageID: tool.messageID,
                questionID: question.id,
                questionBlocking: question.blocking,
              },
            })
          } catch (error) {
            await saveWorker(ctx, worker)
            throw error
          }
          if (question.blocking) {
            await saveReport(ctx, {
              hiveID: worker.hiveID,
              agentName: worker.agentName,
              projectName: worker.projectName,
              workspaceName: worker.workspaceName,
              sessionID: worker.sessionID,
              dispatchID: worker.dispatchID,
              status: "blocked",
              summary: `Waiting for controller answer to ${question.id}: ${question.question}`,
              todos: ["Receive controller response"],
              createdAt: question.createdAt,
            })
          }
          return text(
            `Sent ${question.id} to the Hive controller. ${
              question.blocking ? "Work is waiting for a reply." : "Continue independent work if useful."
            }`,
            { hiveID: worker.hiveID, questionID: question.id, channelSessionID: worker.channelSessionID },
          )
        },
      })

      editor.add({
        name: "reply",
        description: "Reply from the registered Hive channel to a worker question without creating a new dispatch.",
        input: replyInput,
        options: { namespace: "hive" },
        execute: async (rawInput: unknown, tool: ToolContext) => {
          const input = rawInput as { hive?: string; sessionID: string; questionID?: string; answer: string }
          const { hive } = await controllerHive(ctx, tool.sessionID, input.hive)
          const worker = await workerForSession(ctx, input.sessionID)
          if (worker.hiveID !== hive.id) throw new Error(`${input.sessionID} belongs to Hive ${worker.hiveID}`)
          if (input.questionID && worker.pendingQuestion?.id !== input.questionID) {
            throw new Error(`Worker ${input.sessionID} is not waiting for question ${input.questionID}`)
          }
          const pending = worker.pendingQuestion
          await ctx.session.prompt({
            sessionID: worker.sessionID,
            text: [
              `Reply from Hive controller${pending ? ` for ${pending.id}` : ""}:`,
              pending ? `Your question: ${pending.question}` : undefined,
              `Answer: ${input.answer}`,
              pending
                ? `Call hive_ack_reply with questionID ${pending.id} before continuing so the controller knows you received this reply.`
                : undefined,
              "Continue the current work if this resolves the question. Otherwise ask one focused follow-up.",
            ]
              .filter((value): value is string => !!value)
              .join("\n\n"),
            delivery: "queue",
            metadata: {
              hiveID: hive.id,
              hiveDispatchID: worker.dispatchID,
              ...(pending ? { questionID: pending.id } : {}),
              sourceSessionID: tool.sessionID,
            },
          })
          const updated = pending
            ? {
                ...worker,
                pendingQuestion: {
                  ...pending,
                  status: "reply-queued" as const,
                  replyQueuedAt: Date.now(),
                },
              }
            : worker
          await saveWorker(ctx, updated)
          return text(
            `Queued reply to ${worker.agentName} in session ${worker.sessionID}. Worker receipt is not confirmed yet.`,
          )
        },
      })

      editor.add({
        name: "ack_reply",
        description: "Acknowledge receipt of a queued Hive controller reply without waking the controller model.",
        input: acknowledgeReplyInput,
        options: { namespace: "hive" },
        execute: async (rawInput: unknown, tool: ToolContext) => {
          const input = rawInput as { questionID: string }
          const worker = await workerForSession(ctx, tool.sessionID)
          const pending = worker.pendingQuestion
          if (!pending || pending.id !== input.questionID) {
            throw new Error(`No pending question ${input.questionID} for this worker`)
          }
          if (pending.status !== "reply-queued") {
            throw new Error(`Question ${input.questionID} does not have a queued controller reply`)
          }
          const updated = { ...worker }
          delete updated.pendingQuestion
          await saveWorker(ctx, updated)
          await ctx.session.synthetic({
            sessionID: worker.channelSessionID,
            text: `Hive reply received by ${worker.agentName} [${pending.id}] | ${worker.projectName}/${worker.workspaceName}`,
            description: "Hive reply receipt",
            resume: false,
            metadata: {
              hiveID: worker.hiveID,
              hiveAgent: worker.agentName,
              hiveDispatchID: worker.dispatchID,
              sourceSessionID: worker.sessionID,
              questionID: pending.id,
            },
          })
          return text(`Acknowledged controller reply ${pending.id}.`)
        },
      })

      editor.add({
        name: "request_controller",
        description:
          "Relay an action the user directly requested in this worker session to the Hive controller with a verified OpenCode user-message reference.",
        input: requestControllerInput,
        options: { namespace: "hive" },
        execute: async (rawInput: unknown, tool: ToolContext) => {
          const input = rawInput as { request: string }
          const worker = await workerForSession(ctx, tool.sessionID)
          const source = await initiatingDirectUserMessage(ctx, tool)
          const sourceText = clamp(oneLine(source.text), 4_000) ?? ""
          const authorization: AuthorizationRecord = {
            id: `auth_${crypto.randomUUID().slice(0, 12)}`,
            hiveID: worker.hiveID,
            request: oneLine(input.request),
            relayedByAgent: worker.agentName,
            workerSessionID: worker.sessionID,
            sourceUserSessionID: worker.sessionID,
            sourceUserMessageID: source.id,
            sourceUserText: sourceText,
            sourceUserTextHash: createHash("sha256").update(source.text).digest("hex"),
            createdAt: Date.now(),
          }
          await ctx.storage.set(authorizationKey(authorization.id), { ...authorization })
          await ctx.storage.set(`hives/${worker.hiveID}/authorizations/${authorization.id}`, { ...authorization })
          try {
            await ctx.session.prompt({
              sessionID: worker.channelSessionID,
              text: [
                `Hive user-authorized request via ${worker.agentName} [${authorization.id}]`,
                `Request: ${authorization.request}`,
                `Authorizing user message: ${shorten(sourceText, 600)}`,
                `OpenCode source: ${authorization.sourceUserSessionID}/${authorization.sourceUserMessageID}`,
                `Open: ${openChamberLink(worker.sessionID, worker.workspaceDirectory)}`,
              ].join(" | "),
              delivery: "queue",
              metadata: {
                hiveID: worker.hiveID,
                hiveAgent: worker.agentName,
                hiveDispatchID: worker.dispatchID,
                authorizationID: authorization.id,
                sourceSessionID: worker.sessionID,
                sourceUserMessageID: source.id,
                sourceToolMessageID: tool.messageID,
              },
            })
          } catch (error) {
            await ctx.storage.remove(authorizationKey(authorization.id))
            await ctx.storage.remove(`hives/${worker.hiveID}/authorizations/${authorization.id}`)
            throw error
          }
          return text(
            `Relayed ${authorization.id} to the Hive controller with OpenCode source ${authorization.sourceUserSessionID}/${authorization.sourceUserMessageID}.`,
            { hiveID: worker.hiveID, authorizationID: authorization.id },
          )
        },
      })

      editor.add({
        name: "verify_authorization",
        description:
          "Verify the OpenCode user-message reference attached to a worker-relayed controller request. Reports never create authorization.",
        input: verifyAuthorizationInput,
        options: { namespace: "hive" },
        execute: async (rawInput: unknown, tool: ToolContext) => {
          const input = rawInput as { hive?: string; authorizationID: string }
          const { hive } = await controllerHive(ctx, tool.sessionID, input.hive)
          const authorization = (await ctx.storage.get(
            authorizationKey(input.authorizationID),
          )) as AuthorizationRecord | undefined
          if (!authorization) throw new Error(`Unknown authorization: ${input.authorizationID}`)
          if (authorization.hiveID !== hive.id) {
            throw new Error(`${input.authorizationID} belongs to Hive ${authorization.hiveID}`)
          }
          return text(
            [
              `Verified Hive authorization ${authorization.id}`,
              `Request: ${authorization.request}`,
              `Direct user message: ${authorization.sourceUserText}`,
              `OpenCode source: ${authorization.sourceUserSessionID}/${authorization.sourceUserMessageID}`,
              `SHA-256: ${authorization.sourceUserTextHash}`,
              `Relayed by: ${authorization.relayedByAgent}`,
            ].join("\n"),
            {
              hiveID: authorization.hiveID,
              authorizationID: authorization.id,
              sourceSessionID: authorization.sourceUserSessionID,
              sourceUserMessageID: authorization.sourceUserMessageID,
            },
          )
        },
      })

      editor.add({
        name: "report",
        description: "Report worker progress, blockers, completion, or failure to the registered Hive channel.",
        input: reportInput,
        options: { namespace: "hive" },
        execute: async (
          rawInput: unknown,
          tool: ToolContext,
        ) => {
          const input = rawInput as {
            status: "started" | "milestone" | "blocked" | "completed" | "failed"
            summary: string
            commit?: string
            todos?: string[]
          }
          const record = await workerForSession(ctx, tool.sessionID)
          if (input.status === "blocked" && record.pendingQuestion?.blocking) {
            return text(
              `Blocked report suppressed because ${record.pendingQuestion.id} already represents this blocked state.`,
              { hiveID: record.hiveID, questionID: record.pendingQuestion.id, suppressed: true },
            )
          }
          const reportParts = [
            `Hive report from ${record.agentName} [${input.status}]`,
            `${record.projectName}/${record.workspaceName}: ${oneLine(input.summary)}`,
          ]
          if (input.commit) reportParts.push(`Commit: ${oneLine(input.commit)}`)
          if (input.todos?.length) reportParts.push(`TODOs: ${input.todos.map(oneLine).join("; ")}`)
          reportParts.push(`Open: ${openChamberLink(tool.sessionID, record.workspaceDirectory)}`)

          const report: ReportRecord = {
            hiveID: record.hiveID,
            agentName: record.agentName,
            projectName: record.projectName,
            workspaceName: record.workspaceName,
            sessionID: tool.sessionID,
            dispatchID: record.dispatchID,
            status: input.status,
            summary: input.summary,
            commit: input.commit,
            todos: input.todos ?? [],
            createdAt: Date.now(),
          }
          await saveReport(ctx, report)
          const updated = { ...record, lastStatus: input.status, lastReportAt: report.createdAt }
          if (record.pendingQuestion?.status === "reply-queued") delete updated.pendingQuestion
          await saveWorker(ctx, updated)

          await ctx.session.prompt({
            sessionID: record.channelSessionID,
            text: reportParts.join(" | "),
            delivery: "queue",
            metadata: {
              hiveID: record.hiveID,
              hiveAgent: record.agentName,
              hiveDispatchID: record.dispatchID,
              sourceSessionID: tool.sessionID,
              sourceMessageID: tool.messageID,
              reportStatus: input.status,
            },
          })
          return text(`Reported ${input.status} to Hive ${record.hiveID}.`)
        },
      })

      editor.add({
        name: "sessions",
        description: "List worker sessions launched by a Hive with OpenChamber links.",
        input: sessionsInput,
        options: { namespace: "hive" },
        execute: async (rawInput: unknown, tool: ToolContext) => {
          const input = rawInput as { hive?: string }
          const hives = await configuredHives(ctx)
          const hive = await selectHive(ctx, hives, tool.sessionID, input.hive)
          const workers = await ctx.storage.scan({ prefix: `hives/${hive.id}/workers/`, limit: 1_000 })
          const records = workers.entries
            .map((entry) => entry.value as unknown as WorkerRecord)
            .sort(
              (left, right) =>
                (right.lastDispatchAt ?? right.createdAt) - (left.lastDispatchAt ?? left.createdAt),
            )
          const detached = await ctx.storage.scan({ prefix: `hives/${hive.id}/detached/`, limit: 1_000 })
          const detachedRecords = detached.entries
            .map((entry) => entry.value as unknown as DetachedWorkerRecord)
            .sort((left, right) => right.detachedAt - left.detachedAt)
          if (records.length === 0 && detachedRecords.length === 0) {
            return text(`No worker sessions for ${hive.name}.`)
          }
          const active = records
              .map(
                (record) =>
                  `- ${record.agentName} in ${record.projectName}/${record.workspaceName}: ${record.sessionID} | dispatches: ${
                    record.dispatchCount ?? 1
                  } | last status: ${record.lastStatus ?? "not reported"}${
                    record.identityState === "recovered" ? " | identity: recovered, permissions: ask" : ""
                  }${
                    record.pendingQuestion
                      ? ` | ${
                          record.pendingQuestion.status === "awaiting-controller"
                            ? "awaiting controller"
                            : "reply awaiting receipt"
                        }: ${record.pendingQuestion.id}`
                      : ""
                  } | ${openChamberLink(
                    record.sessionID,
                    record.workspaceDirectory,
                  )}`,
              )
          const historical = detachedRecords.map(
            (record) =>
              `- detached ${record.sessionID} | ${record.reason} at ${new Date(record.detachedAt).toISOString()}`,
          )
          return text(
            [
              ...(active.length ? ["Active workers:", ...active] : []),
              ...(historical.length ? ["Detached historical sessions:", ...historical] : []),
            ].join("\n"),
          )
        },
      })
    })
  },
})
