// @bun
// src/index.ts
import { Plugin } from "@opencode/plugin";
import { createHash } from "crypto";
import { resolve as resolve2 } from "path";
import { fileURLToPath } from "url";

// src/config.ts
import { stat } from "fs/promises";
import { dirname, isAbsolute, resolve } from "path";
function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}
function string(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}
function optionalString(value, label) {
  return value === undefined ? undefined : string(value, label);
}
function optionalPermissionMode(value, label) {
  if (value === undefined)
    return;
  if (value !== "ask" && value !== "auto")
    throw new Error(`${label} must be ask or auto`);
  return value;
}
function stringArray(value, label) {
  if (value === undefined)
    return [];
  if (!Array.isArray(value))
    throw new Error(`${label} must be an array`);
  return value.map((item, index) => string(item, `${label}[${index}]`));
}
function parseAgent(value, label) {
  const input = object(value, label);
  return {
    openCodeAgent: optionalString(input.openCodeAgent, `${label}.openCodeAgent`) ?? "build",
    model: optionalString(input.model, `${label}.model`),
    instructions: optionalString(input.instructions, `${label}.instructions`),
    permissionMode: optionalPermissionMode(input.permissionMode, `${label}.permissionMode`)
  };
}
function parseWorkspace(value, label, baseDirectory) {
  const input = object(value, label);
  const configuredDirectory = string(input.directory, `${label}.directory`);
  return {
    name: string(input.name, `${label}.name`),
    directory: resolve(baseDirectory, configuredDirectory),
    branch: optionalString(input.branch, `${label}.branch`),
    defaultAgent: optionalString(input.defaultAgent, `${label}.defaultAgent`),
    aliases: stringArray(input.aliases, `${label}.aliases`),
    permissionMode: optionalPermissionMode(input.permissionMode, `${label}.permissionMode`)
  };
}
function parseProject(value, label, baseDirectory) {
  const input = object(value, label);
  if (!Array.isArray(input.workspaces) || input.workspaces.length === 0) {
    throw new Error(`${label}.workspaces must contain at least one workspace`);
  }
  const workspaces = input.workspaces.map((workspace, index) => parseWorkspace(workspace, `${label}.workspaces[${index}]`, baseDirectory));
  const names = new Set;
  for (const workspace of workspaces) {
    if (names.has(workspace.name))
      throw new Error(`${label} has duplicate workspace ${workspace.name}`);
    names.add(workspace.name);
  }
  return {
    defaultWorkspace: optionalString(input.defaultWorkspace, `${label}.defaultWorkspace`),
    workspaces
  };
}
function parseHiveConfig(value, configPath) {
  const input = object(value, configPath);
  if (input.version !== 1)
    throw new Error(`${configPath}.version must be 1`);
  const agentsInput = object(input.agents, `${configPath}.agents`);
  const agents = Object.fromEntries(Object.entries(agentsInput).map(([name, agent]) => [name, parseAgent(agent, `agents.${name}`)]));
  if (Object.keys(agents).length === 0)
    throw new Error(`${configPath}.agents must not be empty`);
  const configDirectory = dirname(configPath);
  const projectsInput = object(input.projects, `${configPath}.projects`);
  const projects = Object.fromEntries(Object.entries(projectsInput).map(([name, project]) => [
    name,
    parseProject(project, `projects.${name}`, configDirectory)
  ]));
  if (Object.keys(projects).length === 0)
    throw new Error(`${configPath}.projects must not be empty`);
  for (const [projectName, project] of Object.entries(projects)) {
    if (project.defaultWorkspace && !project.workspaces.some((workspace) => workspace.name === project.defaultWorkspace)) {
      throw new Error(`projects.${projectName}.defaultWorkspace does not name a workspace`);
    }
    for (const workspace of project.workspaces) {
      if (workspace.defaultAgent && !agents[workspace.defaultAgent]) {
        throw new Error(`projects.${projectName}/${workspace.name} references unknown agent ${workspace.defaultAgent}`);
      }
    }
  }
  const channelInput = input.channel === undefined ? {} : object(input.channel, `${configPath}.channel`);
  const contextMessages = channelInput.contextMessages ?? 12;
  if (!Number.isInteger(contextMessages) || Number(contextMessages) < 0 || Number(contextMessages) > 100) {
    throw new Error(`${configPath}.channel.contextMessages must be an integer from 0 to 100`);
  }
  const defaultAgent = optionalString(channelInput.defaultAgent, `${configPath}.channel.defaultAgent`);
  if (defaultAgent && !agents[defaultAgent]) {
    throw new Error(`${configPath}.channel.defaultAgent references unknown agent ${defaultAgent}`);
  }
  const id = string(input.id, `${configPath}.id`);
  return {
    version: 1,
    id,
    name: optionalString(input.name, `${configPath}.name`) ?? id,
    permissionMode: optionalPermissionMode(input.permissionMode, `${configPath}.permissionMode`) ?? "ask",
    channel: { defaultAgent, contextMessages: Number(contextMessages) },
    agents,
    projects,
    configPath,
    directory: configDirectory
  };
}
async function loadHiveConfig(configPath) {
  const absolutePath = isAbsolute(configPath) ? configPath : resolve(configPath);
  const file = Bun.file(absolutePath);
  if (!await file.exists())
    throw new Error(`Hive config does not exist: ${absolutePath}`);
  return parseHiveConfig(await file.json(), absolutePath);
}
function resolveWorkspace(config, reference) {
  const slash = reference.indexOf("/");
  const projectName = slash === -1 ? reference : reference.slice(0, slash);
  const selector = slash === -1 ? undefined : reference.slice(slash + 1);
  const project = config.projects[projectName];
  if (!project)
    throw new Error(`Unknown Hive project: ${projectName}`);
  let matches;
  if (!selector) {
    if (project.defaultWorkspace) {
      matches = project.workspaces.filter((workspace) => workspace.name === project.defaultWorkspace);
    } else if (project.workspaces.length === 1) {
      matches = project.workspaces;
    } else {
      throw new Error(`${projectName} has multiple workspaces; use ${projectName}/<workspace-or-branch>`);
    }
  } else {
    matches = project.workspaces.filter((workspace) => workspace.name === selector || workspace.branch === selector || workspace.aliases.includes(selector));
  }
  if (matches.length === 0)
    throw new Error(`Unknown Hive workspace: ${reference}`);
  if (matches.length > 1)
    throw new Error(`Ambiguous Hive workspace: ${reference}`);
  return { projectName, workspace: matches[0], reference: `${projectName}/${matches[0].name}` };
}
async function assertWorkspaceDirectory(workspace) {
  let info;
  try {
    info = await stat(workspace.directory);
  } catch {
    throw new Error(`Workspace directory does not exist: ${workspace.directory}`);
  }
  if (!info.isDirectory())
    throw new Error(`Workspace path is not a directory: ${workspace.directory}`);
}
function configPathsFromOptions(options, location) {
  const configured = options.configs;
  if (configured !== undefined) {
    if (!Array.isArray(configured) || configured.some((path) => typeof path !== "string")) {
      throw new Error("Hive plugin option 'configs' must be an array of paths");
    }
    return configured.map((path) => {
      if (!isAbsolute(path))
        throw new Error(`Hive config paths in plugin options must be absolute: ${path}`);
      return path;
    });
  }
  return [resolve(location, "hive.json")];
}

// src/index.ts
var initInput = {
  type: "object",
  properties: {
    hive: { type: "string", description: "Hive ID. Optional when exactly one config is loaded." },
    replace: {
      type: "boolean",
      description: "Replace the registered channel with this session. Use only when intentionally starting fresh."
    },
    clearHistory: {
      type: "boolean",
      description: "Forget indexed workers and reports without deleting their OpenCode sessions."
    }
  },
  additionalProperties: false
};
var statusInput = {
  type: "object",
  properties: {
    hive: { type: "string", description: "Hive ID. Optional when exactly one config is loaded." }
  },
  additionalProperties: false
};
var dispatchInput = {
  type: "object",
  properties: {
    hive: { type: "string", description: "Hive ID. Usually inferred from the current channel." },
    agent: { type: "string", description: "Named Hive agent. Uses the workspace default when omitted." },
    workspace: {
      type: "string",
      description: "Workspace reference such as brikk-house/main. Branches and aliases also resolve."
    },
    request: { type: "string", description: "The work request to send to the worker." },
    mode: {
      type: "string",
      enum: ["new", "continue"],
      description: "Create a new worker or continue an exact existing worker session. Defaults to new."
    },
    sessionID: {
      type: "string",
      description: "Existing Hive worker session. Required when mode is continue."
    },
    relevantSummary: {
      type: "string",
      description: "A short coordinator-written summary of facts and context relevant to this request."
    },
    memoryItems: {
      type: "array",
      items: { type: "string" },
      description: "Small durable facts, decisions, or references that may matter to this work."
    }
  },
  required: ["workspace", "request"],
  additionalProperties: false
};
var consultSessionInput = {
  type: "object",
  properties: {
    hive: { type: "string", description: "Hive ID. Usually inferred from the current channel." },
    sessionID: { type: "string", description: "Existing Hive worker session to consult." },
    request: { type: "string", description: "Proposed follow-up work." },
    relevantSummary: { type: "string", description: "Optional new context relevant to the proposed work." }
  },
  required: ["sessionID", "request"],
  additionalProperties: false
};
var askControllerInput = {
  type: "object",
  properties: {
    question: { type: "string", description: "Focused question for the Hive controller or user." },
    blocking: { type: "boolean", description: "Whether work is blocked until the answer arrives." }
  },
  required: ["question"],
  additionalProperties: false
};
var replyInput = {
  type: "object",
  properties: {
    hive: { type: "string", description: "Hive ID. Usually inferred from the current channel." },
    sessionID: { type: "string", description: "Hive worker session that asked the question." },
    questionID: { type: "string", description: "Optional question ID shown in the Hive channel." },
    answer: { type: "string", description: "Controller or user answer to send back to the worker." }
  },
  required: ["sessionID", "answer"],
  additionalProperties: false
};
var acknowledgeReplyInput = {
  type: "object",
  properties: {
    questionID: { type: "string", description: "Question ID whose queued controller reply was received." }
  },
  required: ["questionID"],
  additionalProperties: false
};
var requestControllerInput = {
  type: "object",
  properties: {
    request: {
      type: "string",
      description: "Action the user directly instructed this worker to relay to the Hive controller."
    }
  },
  required: ["request"],
  additionalProperties: false
};
var verifyAuthorizationInput = {
  type: "object",
  properties: {
    hive: { type: "string", description: "Hive ID. Usually inferred from the current channel." },
    authorizationID: { type: "string", description: "Authorization ID attached to the relayed request." }
  },
  required: ["authorizationID"],
  additionalProperties: false
};
var recentStatusInput = {
  type: "object",
  properties: {
    hive: { type: "string", description: "Hive ID. Inferred for Hive channels and workers." },
    limit: { type: "integer", minimum: 1, maximum: 50, description: "Maximum reports. Defaults to 10." },
    agent: { type: "string", description: "Optional Hive agent filter." },
    project: { type: "string", description: "Optional project filter." }
  },
  additionalProperties: false
};
var backfillDetailsInput = {
  type: "object",
  properties: {
    question: {
      type: "string",
      description: "What additional context the worker needs from the Hive."
    }
  },
  required: ["question"],
  additionalProperties: false
};
var reportInput = {
  type: "object",
  properties: {
    status: {
      type: "string",
      enum: ["started", "milestone", "blocked", "completed", "failed"],
      description: "Worker status at this reporting boundary."
    },
    summary: { type: "string", description: "Concise report for the Hive channel." },
    commit: { type: "string", description: "Optional commit SHA." },
    todos: { type: "array", items: { type: "string" }, description: "Optional remaining work." }
  },
  required: ["status", "summary"],
  additionalProperties: false
};
var sessionsInput = statusInput;
function text(content, metadata) {
  return { content, metadata };
}
function workerKey(sessionID) {
  return `workers/${sessionID}`;
}
function channelKey(hiveID) {
  return `channels/${hiveID}`;
}
function sourceChannelKey(sessionID) {
  return `channel-sessions/${sessionID}`;
}
function dispatchKey(hiveID, dispatchID) {
  return `hives/${hiveID}/dispatches/${dispatchID}`;
}
function authorizationKey(authorizationID) {
  return `authorizations/${authorizationID}`;
}
async function saveWorker(ctx, worker) {
  await ctx.storage.set(workerKey(worker.sessionID), { ...worker });
  await ctx.storage.set(`hives/${worker.hiveID}/workers/${worker.sessionID}`, { ...worker });
}
async function saveReport(ctx, report) {
  await ctx.storage.set(`hives/${report.hiveID}/reports/${report.createdAt}-${crypto.randomUUID()}`, {
    ...report
  });
}
function modelRef(model) {
  if (!model)
    return;
  const slash = model.indexOf("/");
  if (slash < 1 || slash === model.length - 1) {
    throw new Error(`Agent model must use provider/model format: ${model}`);
  }
  const providerID = model.slice(0, slash);
  const modelAndVariant = model.slice(slash + 1);
  const hash = modelAndVariant.lastIndexOf("#");
  if (hash === -1)
    return { providerID, id: modelAndVariant };
  return {
    providerID,
    id: modelAndVariant.slice(0, hash),
    variant: modelAndVariant.slice(hash + 1)
  };
}
function openChamberLink(sessionID, directory) {
  return `openchamber://session/${sessionID}?dir=${encodeURIComponent(directory)}`;
}
function shorten(value, length) {
  const line = value.replaceAll(/\s+/g, " ").trim();
  return line.length <= length ? line : `${line.slice(0, length - 1)}\u2026`;
}
function oneLine(value) {
  return value.replaceAll(/\s+/g, " ").trim();
}
function clamp(value, maxCharacters) {
  if (!value)
    return;
  if (value.length <= maxCharacters)
    return value;
  return `${value.slice(0, maxCharacters - 1)}\u2026`;
}
function conversationalText(message) {
  if (!message || typeof message !== "object")
    return;
  const value = message;
  if ((value.type === "user" || value.type === "synthetic") && typeof value.text === "string") {
    return `${value.type === "user" ? "User" : "Log"}: ${value.text}`;
  }
  if (value.type === "assistant" && Array.isArray(value.content)) {
    const content = value.content.filter((part) => !!part && typeof part === "object" && part.type === "text" && typeof part.text === "string").map((part) => part.text).join(`
`);
    return content ? `Assistant: ${content}` : undefined;
  }
  return;
}
function messageCreatedAt(message) {
  if (!message || typeof message !== "object")
    return;
  const time = message.time;
  if (!time || typeof time !== "object")
    return;
  const created = time.created;
  return typeof created === "number" ? created : undefined;
}
function messageID(message) {
  if (!message || typeof message !== "object")
    return;
  const id = message.id;
  return typeof id === "string" ? id : undefined;
}
function isDirectUserMessage(message) {
  if (!message || typeof message !== "object")
    return false;
  const value = message;
  if (value.type !== "user" || typeof value.id !== "string" || typeof value.text !== "string")
    return false;
  const metadata = value.metadata;
  if (!metadata || typeof metadata !== "object")
    return true;
  const fields = metadata;
  return !(fields.hiveID || fields.hiveDispatchID || fields.sourceSessionID || fields.authorizationID || fields.questionID);
}
function isUserMessage(message) {
  return !!message && typeof message === "object" && message.type === "user";
}
async function initiatingDirectUserMessage(ctx, tool) {
  const messages = await ctx.session.context({ sessionID: tool.sessionID });
  const assistantIndex = messages.findIndex((message) => messageID(message) === tool.messageID);
  const beforeTool = assistantIndex === -1 ? messages : messages.slice(0, assistantIndex);
  const source = [...beforeTool].reverse().find(isUserMessage);
  if (!isDirectUserMessage(source)) {
    throw new Error("The current worker turn was not initiated by a direct user message. Ask the user in this worker session or ask the Hive controller to obtain confirmation.");
  }
  return source;
}
async function channelUpdates(ctx, record, messageCount) {
  if (messageCount === 0)
    return;
  const messages = await ctx.session.context({ sessionID: record.channelSessionID });
  const since = record.lastDispatchAt ?? record.createdAt;
  const selected = messages.filter((message) => (messageCreatedAt(message) ?? 0) > since).map(conversationalText).filter((message) => !!message).slice(-messageCount);
  if (selected.length === 0)
    return;
  return clamp(selected.join(`

`), 16000);
}
async function hiveMarkdown(config) {
  const names = ["MEMORY.md", "PLAN.md", "TODO.md", "PROGRESS.md"];
  const sections = [];
  for (const name of names) {
    const file = Bun.file(`${config.directory}/${name}`);
    if (!await file.exists())
      continue;
    const content = clamp(await file.text(), 6000);
    if (content)
      sections.push(`## ${name}
${content}`);
  }
  return clamp(sections.join(`

`), 18000);
}
async function relatedReports(ctx, record) {
  const page = await ctx.storage.scan({ prefix: `hives/${record.hiveID}/reports/`, limit: 1000 });
  const reports = page.entries.map((entry) => entry.value).filter((report) => report.sessionID !== record.sessionID && (report.projectName === record.projectName || report.agentName === record.agentName)).sort((left, right) => right.createdAt - left.createdAt).slice(0, 8);
  if (reports.length === 0)
    return;
  return reports.map((report) => `[${report.status}] ${report.agentName} in ${report.projectName}/${report.workspaceName}: ${report.summary}${report.commit ? ` (commit ${report.commit})` : ""}
Source session: ${report.sessionID}`).join(`

`);
}
async function relatedSessionSummaries(ctx, record) {
  const page = await ctx.storage.scan({ prefix: `hives/${record.hiveID}/workers/`, limit: 1000 });
  const related = page.entries.map((entry) => entry.value).filter((worker) => worker.sessionID !== record.sessionID && (worker.projectName === record.projectName || worker.agentName === record.agentName)).sort((left, right) => right.createdAt - left.createdAt).slice(0, 3);
  const summaries = [];
  for (const worker of related) {
    try {
      const messages = await ctx.session.context({ sessionID: worker.sessionID });
      const summary = messages.map(conversationalText).filter((value) => !!value).at(-1);
      if (!summary)
        continue;
      summaries.push(`${worker.agentName} in ${worker.projectName}/${worker.workspaceName}:
${clamp(summary, 3000)}
Source session: ${worker.sessionID}`);
    } catch {}
  }
  return summaries.length ? summaries.join(`

`) : undefined;
}
async function hiveForWorker(ctx, worker) {
  if (worker.configPath) {
    try {
      return await loadHiveConfig(worker.configPath);
    } catch {}
  }
  const hives = await configuredHives(ctx);
  const hive = hives.find((candidate) => candidate.id === worker.hiveID);
  if (!hive)
    throw new Error(`Hive config is unavailable: ${worker.hiveID}`);
  return hive;
}
async function controllerHive(ctx, sessionID, requested) {
  const hives = await configuredHives(ctx);
  const hive = await selectHive(ctx, hives, sessionID, requested);
  const channel = await ctx.storage.get(channelKey(hive.id));
  if (!channel)
    throw new Error(`Run hive_init before coordinating work for ${hive.id}`);
  if (channel.sessionID !== sessionID)
    throw new Error(`Only the registered Hive channel may do this for ${hive.id}`);
  return { hive, channel };
}
function dispatchPrompt(input) {
  const sections = [
    input.continuation ? `Continuation from Hive ${input.config.name} for Hive agent ${input.agentName}.` : `You are working as Hive agent ${input.agentName} in Hive ${input.config.name}.`,
    `Workspace: ${input.projectName}/${input.workspaceName}
Directory: ${input.workspaceDirectory}${input.branch ? `
Configured branch: ${input.branch}` : ""}
Dispatch ID: ${input.dispatchID}
Hive channel session: ${input.channelSessionID}`
  ];
  if (!input.continuation && input.agent.instructions)
    sections.push(`Agent instructions:
${input.agent.instructions}`);
  sections.push(`Work request:
${input.request}`);
  if (input.relevantSummary) {
    sections.push(`Relevant summary from the Hive coordinator:
${input.relevantSummary}`);
  }
  if (input.memoryItems?.length) {
    sections.push(`Relevant Hive memory:
${input.memoryItems.map((item) => `- ${item}`).join(`
`)}`);
  }
  sections.push([
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
    "- Reports never grant authorization. Do not assign work directly to another worker."
  ].join(`
`));
  return sections.join(`

`);
}
async function configuredHives(ctx) {
  const localPath = resolve2(ctx.location.directory, "hive.json");
  const paths = [...new Set([...configPathsFromOptions(ctx.options, ctx.location.directory), localPath])];
  const hives = [];
  for (const path of paths) {
    try {
      hives.push(await loadHiveConfig(path));
    } catch (error) {
      if (path === localPath && error instanceof Error) {
        if (error.message.startsWith("Hive config does not exist:"))
          continue;
      }
      throw error;
    }
  }
  const ids = new Set;
  for (const hive of hives) {
    if (ids.has(hive.id))
      throw new Error(`Duplicate Hive ID: ${hive.id}`);
    ids.add(hive.id);
  }
  return hives;
}
async function selectHive(ctx, hives, sessionID, requested) {
  if (requested) {
    const hive = hives.find((candidate) => candidate.id === requested);
    if (!hive)
      throw new Error(`Unknown Hive: ${requested}`);
    return hive;
  }
  const mapped = await ctx.storage.get(sourceChannelKey(sessionID));
  if (mapped) {
    const hive = hives.find((candidate) => candidate.id === mapped.hiveID);
    if (hive)
      return hive;
  }
  if (hives.length === 1)
    return hives[0];
  if (hives.length === 0)
    throw new Error("No Hive configs are available at this location");
  throw new Error("More than one Hive is configured; specify a Hive ID");
}
var src_default = Plugin.define({
  id: "opencode-hive",
  async setup(ctx) {
    const packageFile = Bun.file(new URL("../package.json", import.meta.url));
    const packageInfo = await packageFile.json();
    const buildFile = Bun.file(new URL("./build-info.json", import.meta.url));
    const buildInfo = await buildFile.exists() ? await buildFile.json() : { version: packageInfo.version, buildID: "source-dev", builtAt: "not built" };
    await ctx.permission.hook("evaluate", async (event) => {
      if (event.effect !== "ask")
        return;
      const worker = await ctx.storage.get(workerKey(event.sessionID));
      if (worker?.permissionMode !== "auto")
        return;
      event.effect = "allow";
      event.message = `Auto-approved by Hive ${worker.hiveID} for ${worker.agentName}`;
    });
    const createHiveSkillLocation = fileURLToPath(new URL("../skills/create-hive/SKILL.md", import.meta.url));
    const createHiveSkillSource = await Bun.file(createHiveSkillLocation).text();
    const createHiveSkillContent = createHiveSkillSource.replace(/^---\n[\s\S]*?\n---\n+/, "");
    await ctx.skill.transform((editor) => {
      const skill = {
        id: "create-hive",
        name: "Create Hive",
        description: "Create or extend an OpenCode Hive through conversation, with project, Git worktree, model, and agent discovery.",
        slash: true,
        location: createHiveSkillLocation,
        content: createHiveSkillContent
      };
      editor.add(skill);
    });
    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "hive",
        description: "Dispatch named Hive agents to configured workspaces and report their progress."
      });
      editor.add({
        name: "init",
        description: "Register the current OpenCode session as a Hive's coordination and progress channel.",
        input: initInput,
        options: { namespace: "hive" },
        execute: async (rawInput, tool) => {
          const input = rawInput;
          const hives = await configuredHives(ctx);
          const hive = await selectHive(ctx, hives, tool.sessionID, input.hive);
          const session = await ctx.session.get({ sessionID: tool.sessionID });
          const previous = await ctx.storage.get(channelKey(hive.id));
          if (previous && previous.sessionID !== tool.sessionID && !input.replace) {
            throw new Error(`Hive ${hive.id} is already registered to session ${previous.sessionID}`);
          }
          const record = {
            hiveID: hive.id,
            sessionID: tool.sessionID,
            directory: session.location.directory
          };
          if (previous && previous.sessionID !== tool.sessionID) {
            await ctx.storage.remove(sourceChannelKey(previous.sessionID));
          }
          if (input.replace) {
            const workers = await ctx.storage.scan({ prefix: `hives/${hive.id}/workers/`, limit: 1000 });
            for (const entry of workers.entries) {
              const worker = entry.value;
              const updated = {
                ...worker,
                channelSessionID: tool.sessionID,
                channelDirectory: session.location.directory
              };
              await ctx.storage.set(entry.key, updated);
              await ctx.storage.set(workerKey(worker.sessionID), updated);
            }
          }
          if (input.clearHistory) {
            const workers = await ctx.storage.scan({ prefix: `hives/${hive.id}/workers/`, limit: 1000 });
            for (const entry of workers.entries) {
              const worker = entry.value;
              await ctx.storage.remove(entry.key);
              await ctx.storage.remove(workerKey(worker.sessionID));
            }
            const reports = await ctx.storage.scan({ prefix: `hives/${hive.id}/reports/`, limit: 1000 });
            for (const entry of reports.entries)
              await ctx.storage.remove(entry.key);
            const dispatches = await ctx.storage.scan({ prefix: `hives/${hive.id}/dispatches/`, limit: 1000 });
            for (const entry of dispatches.entries)
              await ctx.storage.remove(entry.key);
            const authorizations = await ctx.storage.scan({
              prefix: `hives/${hive.id}/authorizations/`,
              limit: 1000
            });
            for (const entry of authorizations.entries) {
              const authorization = entry.value;
              await ctx.storage.remove(entry.key);
              await ctx.storage.remove(authorizationKey(authorization.id));
            }
          }
          await ctx.storage.set(channelKey(hive.id), { ...record });
          await ctx.storage.set(sourceChannelKey(tool.sessionID), { ...record });
          return text(`Registered ${hive.name} channel.
Session: ${tool.sessionID}`);
        }
      });
      editor.add({
        name: "status",
        description: "Show a Hive's configured agents, workspaces, channel, and worker count.",
        input: statusInput,
        options: { namespace: "hive" },
        execute: async (rawInput, tool) => {
          const input = rawInput;
          const hives = await configuredHives(ctx);
          const hive = await selectHive(ctx, hives, tool.sessionID, input.hive);
          const channel = await ctx.storage.get(channelKey(hive.id));
          const workers = await ctx.storage.scan({ prefix: "workers/", limit: 1000 });
          const hiveWorkers = workers.entries.map((entry) => entry.value).filter((worker) => worker.hiveID === hive.id);
          const workerCount = hiveWorkers.length;
          const pendingQuestions = hiveWorkers.filter((worker) => worker.pendingQuestion?.status === "awaiting-controller").length;
          const queuedReplies = hiveWorkers.filter((worker) => worker.pendingQuestion?.status === "reply-queued").length;
          const workspaces = Object.entries(hive.projects).flatMap(([project, definition]) => definition.workspaces.map((workspace) => `- ${project}/${workspace.name}: ${workspace.directory} -> ${workspace.defaultAgent ?? "no default agent"}`));
          return text([
            `${hive.name} (${hive.id})`,
            `Hive plugin: ${buildInfo.version} (${buildInfo.buildID}, built ${buildInfo.builtAt})`,
            `OpenCode: ${ctx.app.name} ${ctx.app.version} (${ctx.app.channel}), server pid ${process.pid}`,
            `Channel: ${channel?.sessionID ?? "not registered"}`,
            `Agents: ${Object.keys(hive.agents).join(", ")}`,
            `Workers: ${workerCount}`,
            `Questions awaiting controller: ${pendingQuestions}`,
            `Replies awaiting worker receipt: ${queuedReplies}`,
            "Workspaces:",
            ...workspaces
          ].join(`
`));
        }
      });
      editor.add({
        name: "dispatch",
        description: "Create a worker session for a named Hive agent in a configured workspace and send it work.",
        input: dispatchInput,
        options: { namespace: "hive" },
        execute: async (rawInput, tool) => {
          const input = rawInput;
          const mode = input.mode ?? "new";
          if (mode === "new" && input.sessionID)
            throw new Error("sessionID is only valid when mode is continue");
          if (mode === "continue" && !input.sessionID)
            throw new Error("mode continue requires sessionID");
          const { hive, channel } = await controllerHive(ctx, tool.sessionID, input.hive);
          const resolved = resolveWorkspace(hive, input.workspace);
          await assertWorkspaceDirectory(resolved.workspace);
          const previous = input.sessionID ? await ctx.storage.get(workerKey(input.sessionID)) : undefined;
          if (mode === "continue" && !previous)
            throw new Error(`Unknown Hive worker session: ${input.sessionID}`);
          const agentName = input.agent ?? previous?.agentName ?? resolved.workspace.defaultAgent;
          if (!agentName)
            throw new Error(`${resolved.reference} has no default agent; specify an agent`);
          const agent = hive.agents[agentName];
          if (!agent)
            throw new Error(`Unknown Hive agent: ${agentName}`);
          if (previous) {
            if (previous.hiveID !== hive.id)
              throw new Error(`${previous.sessionID} belongs to Hive ${previous.hiveID}`);
            if (previous.agentName !== agentName) {
              throw new Error(`${previous.sessionID} belongs to Hive agent ${previous.agentName}, not ${agentName}`);
            }
            if (previous.projectName !== resolved.projectName || previous.workspaceName !== resolved.workspace.name) {
              throw new Error(`${previous.sessionID} belongs to ${previous.projectName}/${previous.workspaceName}, not ${resolved.reference}`);
            }
          }
          const dispatchID = crypto.randomUUID();
          const dispatchedAt = Date.now();
          const permissionMode = resolved.workspace.permissionMode ?? agent.permissionMode ?? hive.permissionMode;
          const session = previous ? await ctx.session.get({ sessionID: previous.sessionID }) : await ctx.session.create({
            title: `${agentName}: ${shorten(input.request, 72)}`,
            agent: agent.openCodeAgent,
            model: modelRef(agent.model),
            location: { directory: resolved.workspace.directory },
            metadata: {
              hiveID: hive.id,
              hiveAgent: agentName,
              hiveWorkspace: resolved.reference,
              hiveDispatchID: dispatchID,
              hiveChannelSessionID: tool.sessionID
            }
          });
          if (session.location.directory !== resolved.workspace.directory) {
            throw new Error(`${session.id} is currently in ${session.location.directory}, not ${resolved.workspace.directory}`);
          }
          const record = previous ? {
            ...previous,
            channelSessionID: tool.sessionID,
            channelDirectory: channel.directory,
            dispatchID,
            request: input.request,
            relevantSummary: input.relevantSummary,
            memoryItems: input.memoryItems ?? [],
            configPath: hive.configPath,
            permissionMode,
            lastDispatchAt: dispatchedAt,
            dispatchCount: (previous.dispatchCount ?? 1) + 1,
            pendingQuestion: undefined
          } : {
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
            permissionMode
          };
          const dispatch = {
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
            createdAt: dispatchedAt
          };
          await saveWorker(ctx, record);
          await ctx.storage.set(dispatchKey(hive.id, dispatchID), { ...dispatch });
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
                continuation: mode === "continue"
              }),
              delivery: "queue",
              metadata: {
                hiveID: hive.id,
                hiveAgent: agentName,
                hiveDispatchID: dispatchID,
                hiveDispatchMode: mode,
                sourceSessionID: tool.sessionID
              }
            });
          } catch (error) {
            await ctx.storage.remove(dispatchKey(hive.id, dispatchID));
            if (previous)
              await saveWorker(ctx, previous);
            else {
              await ctx.storage.remove(workerKey(session.id));
              await ctx.storage.remove(`hives/${hive.id}/workers/${session.id}`);
            }
            throw error;
          }
          return text([
            `${mode === "continue" ? "Continued" : "Dispatched"} ${agentName} in ${resolved.reference}.`,
            `Worker session: ${session.id}`,
            `Open: ${openChamberLink(session.id, resolved.workspace.directory)}`
          ].join(`
`), { hiveID: hive.id, dispatchID, dispatchMode: mode, workerSessionID: session.id });
        }
      });
      editor.add({
        name: "consult_session",
        description: "Ask an existing Hive worker session whether proposed follow-up work belongs in its current context. This is advisory and does not mutate the worker transcript.",
        input: consultSessionInput,
        options: { namespace: "hive" },
        execute: async (rawInput, tool) => {
          const input = rawInput;
          const { hive } = await controllerHive(ctx, tool.sessionID, input.hive);
          const worker = await ctx.storage.get(workerKey(input.sessionID));
          if (!worker)
            throw new Error(`Unknown Hive worker session: ${input.sessionID}`);
          if (worker.hiveID !== hive.id)
            throw new Error(`${input.sessionID} belongs to Hive ${worker.hiveID}`);
          await ctx.session.get({ sessionID: worker.sessionID });
          const recommendation = await ctx.session.generate({
            sessionID: worker.sessionID,
            prompt: [
              "The Hive controller is deciding whether proposed follow-up work belongs in this existing session.",
              "Do not perform the work. Reply with CONTINUE, NEW, or UNCLEAR on the first line, followed by one short reason.",
              `Current Hive identity: ${worker.agentName} in ${worker.projectName}/${worker.workspaceName}`,
              worker.request ? `Most recent request:
${worker.request}` : undefined,
              `Proposed follow-up:
${input.request}`,
              input.relevantSummary ? `New relevant context:
${input.relevantSummary}` : undefined
            ].filter((value) => !!value).join(`

`)
          });
          return text([
            `Consulted ${worker.agentName} in ${worker.projectName}/${worker.workspaceName}:`,
            recommendation.text,
            `Session: ${openChamberLink(worker.sessionID, worker.workspaceDirectory)}`
          ].join(`

`), { hiveID: hive.id, workerSessionID: worker.sessionID });
        }
      });
      editor.add({
        name: "recent_status",
        description: "List the most recent reports in the caller's Hive. Controllers and workers can filter by agent or project before coordinating related work.",
        input: recentStatusInput,
        options: { namespace: "hive" },
        execute: async (rawInput, tool) => {
          const input = rawInput;
          const caller = await ctx.storage.get(workerKey(tool.sessionID));
          let hive;
          if (caller) {
            if (input.hive && input.hive !== caller.hiveID) {
              throw new Error(`Worker ${tool.sessionID} belongs to Hive ${caller.hiveID}`);
            }
            hive = await hiveForWorker(ctx, caller);
          } else {
            hive = (await controllerHive(ctx, tool.sessionID, input.hive)).hive;
          }
          const limit = input.limit ?? 10;
          if (!Number.isInteger(limit) || limit < 1 || limit > 50)
            throw new Error("limit must be from 1 to 50");
          const page = await ctx.storage.scan({ prefix: `hives/${hive.id}/reports/`, limit: 1000 });
          const reports = page.entries.map((entry) => entry.value).filter((report) => !input.agent || report.agentName === input.agent).filter((report) => !input.project || report.projectName === input.project).sort((left, right) => right.createdAt - left.createdAt).slice(0, limit);
          if (reports.length === 0)
            return text(`No matching reports in ${hive.name}.`);
          const lines = [];
          for (const report of reports) {
            const worker = await ctx.storage.get(workerKey(report.sessionID));
            lines.push([
              `${new Date(report.createdAt).toISOString()} [${report.status}] ${report.agentName}`,
              `${report.projectName}/${report.workspaceName}: ${oneLine(report.summary)}`,
              report.commit ? `Commit: ${oneLine(report.commit)}` : undefined,
              worker ? `Open: ${openChamberLink(report.sessionID, worker.workspaceDirectory)}` : `Session: ${report.sessionID}`
            ].filter((value) => !!value).join(" | "));
          }
          return text(lines.join(`
`), { hiveID: hive.id, reportCount: reports.length });
        }
      });
      editor.add({
        name: "backfill_details",
        description: "Ask the Hive for missing context. Returns a focused answer using the dispatch, memory, recent updates, reports, and related sessions without waking the Hive channel.",
        input: backfillDetailsInput,
        options: { namespace: "hive" },
        execute: async (rawInput, tool) => {
          const input = rawInput;
          const record = await ctx.storage.get(workerKey(tool.sessionID));
          if (!record)
            throw new Error("This session is not a Hive worker session");
          const hive = await hiveForWorker(ctx, record);
          const [updates, markdown, reports, sessions] = await Promise.all([
            channelUpdates(ctx, record, hive.channel.contextMessages),
            hiveMarkdown(hive),
            relatedReports(ctx, record),
            relatedSessionSummaries(ctx, record)
          ]);
          const evidence = [
            `Question from ${record.agentName} in ${record.projectName}/${record.workspaceName}:
${input.question}`,
            record.request ? `Original work request:
${clamp(record.request, 6000)}` : undefined,
            record.relevantSummary ? `Coordinator's relevant summary:
${clamp(record.relevantSummary, 8000)}` : undefined,
            record.memoryItems?.length ? `Memory items supplied at dispatch:
${record.memoryItems.map((item) => `- ${clamp(item, 2000)}`).join(`
`)}` : undefined,
            updates ? `Hive channel updates since dispatch:
${updates}` : undefined,
            reports ? `Related worker reports:
${reports}` : undefined,
            sessions ? `Recent related session summaries:
${sessions}` : undefined,
            markdown ? `Current Hive Markdown:
${markdown}` : undefined
          ].filter((section) => !!section);
          const generated = await ctx.session.generate({
            sessionID: record.channelSessionID,
            prompt: [
              "Answer a Hive worker's context backfill question.",
              "Use only the supplied evidence and the Hive channel context. Say when the evidence is uncertain or missing.",
              "Give a concise operational answer. Include source session IDs when they help the worker inspect details.",
              ...evidence
            ].join(`

`)
          });
          return text([
            `Hive backfill for ${record.projectName}/${record.workspaceName}:`,
            generated.text,
            `Hive channel: ${openChamberLink(record.channelSessionID, record.channelDirectory)}`
          ].join(`

`), {
            hiveID: record.hiveID,
            dispatchID: record.dispatchID,
            channelSessionID: record.channelSessionID
          });
        }
      });
      editor.add({
        name: "ask_controller",
        description: "Ask the Hive controller or user for a missing decision or fact. Use context backfill first when the answer may already exist in Hive history.",
        input: askControllerInput,
        options: { namespace: "hive" },
        execute: async (rawInput, tool) => {
          const input = rawInput;
          const worker = await ctx.storage.get(workerKey(tool.sessionID));
          if (!worker)
            throw new Error("This session is not a Hive worker session");
          if (worker.pendingQuestion) {
            throw new Error(`Question ${worker.pendingQuestion.id} is still awaiting a controller reply`);
          }
          const question = {
            id: `q_${crypto.randomUUID().slice(0, 8)}`,
            question: oneLine(input.question),
            blocking: input.blocking ?? false,
            createdAt: Date.now(),
            status: "awaiting-controller"
          };
          const updated = {
            ...worker,
            pendingQuestion: question,
            ...question.blocking ? { lastStatus: "blocked", lastReportAt: question.createdAt } : {}
          };
          await saveWorker(ctx, updated);
          try {
            await ctx.session.prompt({
              sessionID: worker.channelSessionID,
              text: [
                `Hive question from ${worker.agentName} [${question.id}${question.blocking ? ", blocking" : ""}]`,
                `${worker.projectName}/${worker.workspaceName}: ${question.question}`,
                `Open: ${openChamberLink(worker.sessionID, worker.workspaceDirectory)}`
              ].join(" | "),
              delivery: "queue",
              metadata: {
                hiveID: worker.hiveID,
                hiveAgent: worker.agentName,
                hiveDispatchID: worker.dispatchID,
                sourceSessionID: worker.sessionID,
                sourceMessageID: tool.messageID,
                questionID: question.id,
                questionBlocking: question.blocking
              }
            });
          } catch (error) {
            await saveWorker(ctx, worker);
            throw error;
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
              createdAt: question.createdAt
            });
          }
          return text(`Sent ${question.id} to the Hive controller. ${question.blocking ? "Work is waiting for a reply." : "Continue independent work if useful."}`, { hiveID: worker.hiveID, questionID: question.id, channelSessionID: worker.channelSessionID });
        }
      });
      editor.add({
        name: "reply",
        description: "Reply from the registered Hive channel to a worker question without creating a new dispatch.",
        input: replyInput,
        options: { namespace: "hive" },
        execute: async (rawInput, tool) => {
          const input = rawInput;
          const { hive } = await controllerHive(ctx, tool.sessionID, input.hive);
          const worker = await ctx.storage.get(workerKey(input.sessionID));
          if (!worker)
            throw new Error(`Unknown Hive worker session: ${input.sessionID}`);
          if (worker.hiveID !== hive.id)
            throw new Error(`${input.sessionID} belongs to Hive ${worker.hiveID}`);
          if (input.questionID && worker.pendingQuestion?.id !== input.questionID) {
            throw new Error(`Worker ${input.sessionID} is not waiting for question ${input.questionID}`);
          }
          const pending = worker.pendingQuestion;
          await ctx.session.prompt({
            sessionID: worker.sessionID,
            text: [
              `Reply from Hive controller${pending ? ` for ${pending.id}` : ""}:`,
              pending ? `Your question: ${pending.question}` : undefined,
              `Answer: ${input.answer}`,
              pending ? `Call hive_ack_reply with questionID ${pending.id} before continuing so the controller knows you received this reply.` : undefined,
              "Continue the current work if this resolves the question. Otherwise ask one focused follow-up."
            ].filter((value) => !!value).join(`

`),
            delivery: "queue",
            metadata: {
              hiveID: hive.id,
              hiveDispatchID: worker.dispatchID,
              ...pending ? { questionID: pending.id } : {},
              sourceSessionID: tool.sessionID
            }
          });
          const updated = pending ? {
            ...worker,
            pendingQuestion: {
              ...pending,
              status: "reply-queued",
              replyQueuedAt: Date.now()
            }
          } : worker;
          await saveWorker(ctx, updated);
          return text(`Queued reply to ${worker.agentName} in session ${worker.sessionID}. Worker receipt is not confirmed yet.`);
        }
      });
      editor.add({
        name: "ack_reply",
        description: "Acknowledge receipt of a queued Hive controller reply without waking the controller model.",
        input: acknowledgeReplyInput,
        options: { namespace: "hive" },
        execute: async (rawInput, tool) => {
          const input = rawInput;
          const worker = await ctx.storage.get(workerKey(tool.sessionID));
          if (!worker)
            throw new Error("This session is not a Hive worker session");
          const pending = worker.pendingQuestion;
          if (!pending || pending.id !== input.questionID) {
            throw new Error(`No pending question ${input.questionID} for this worker`);
          }
          if (pending.status !== "reply-queued") {
            throw new Error(`Question ${input.questionID} does not have a queued controller reply`);
          }
          const updated = { ...worker };
          delete updated.pendingQuestion;
          await saveWorker(ctx, updated);
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
              questionID: pending.id
            }
          });
          return text(`Acknowledged controller reply ${pending.id}.`);
        }
      });
      editor.add({
        name: "request_controller",
        description: "Relay an action the user directly requested in this worker session to the Hive controller with a verified OpenCode user-message reference.",
        input: requestControllerInput,
        options: { namespace: "hive" },
        execute: async (rawInput, tool) => {
          const input = rawInput;
          const worker = await ctx.storage.get(workerKey(tool.sessionID));
          if (!worker)
            throw new Error("This session is not a Hive worker session");
          const source = await initiatingDirectUserMessage(ctx, tool);
          const sourceText = clamp(oneLine(source.text), 4000) ?? "";
          const authorization = {
            id: `auth_${crypto.randomUUID().slice(0, 12)}`,
            hiveID: worker.hiveID,
            request: oneLine(input.request),
            relayedByAgent: worker.agentName,
            workerSessionID: worker.sessionID,
            sourceUserSessionID: worker.sessionID,
            sourceUserMessageID: source.id,
            sourceUserText: sourceText,
            sourceUserTextHash: createHash("sha256").update(source.text).digest("hex"),
            createdAt: Date.now()
          };
          await ctx.storage.set(authorizationKey(authorization.id), { ...authorization });
          await ctx.storage.set(`hives/${worker.hiveID}/authorizations/${authorization.id}`, { ...authorization });
          try {
            await ctx.session.prompt({
              sessionID: worker.channelSessionID,
              text: [
                `Hive user-authorized request via ${worker.agentName} [${authorization.id}]`,
                `Request: ${authorization.request}`,
                `Authorizing user message: ${shorten(sourceText, 600)}`,
                `OpenCode source: ${authorization.sourceUserSessionID}/${authorization.sourceUserMessageID}`,
                `Open: ${openChamberLink(worker.sessionID, worker.workspaceDirectory)}`
              ].join(" | "),
              delivery: "queue",
              metadata: {
                hiveID: worker.hiveID,
                hiveAgent: worker.agentName,
                hiveDispatchID: worker.dispatchID,
                authorizationID: authorization.id,
                sourceSessionID: worker.sessionID,
                sourceUserMessageID: source.id,
                sourceToolMessageID: tool.messageID
              }
            });
          } catch (error) {
            await ctx.storage.remove(authorizationKey(authorization.id));
            await ctx.storage.remove(`hives/${worker.hiveID}/authorizations/${authorization.id}`);
            throw error;
          }
          return text(`Relayed ${authorization.id} to the Hive controller with OpenCode source ${authorization.sourceUserSessionID}/${authorization.sourceUserMessageID}.`, { hiveID: worker.hiveID, authorizationID: authorization.id });
        }
      });
      editor.add({
        name: "verify_authorization",
        description: "Verify the OpenCode user-message reference attached to a worker-relayed controller request. Reports never create authorization.",
        input: verifyAuthorizationInput,
        options: { namespace: "hive" },
        execute: async (rawInput, tool) => {
          const input = rawInput;
          const { hive } = await controllerHive(ctx, tool.sessionID, input.hive);
          const authorization = await ctx.storage.get(authorizationKey(input.authorizationID));
          if (!authorization)
            throw new Error(`Unknown authorization: ${input.authorizationID}`);
          if (authorization.hiveID !== hive.id) {
            throw new Error(`${input.authorizationID} belongs to Hive ${authorization.hiveID}`);
          }
          return text([
            `Verified Hive authorization ${authorization.id}`,
            `Request: ${authorization.request}`,
            `Direct user message: ${authorization.sourceUserText}`,
            `OpenCode source: ${authorization.sourceUserSessionID}/${authorization.sourceUserMessageID}`,
            `SHA-256: ${authorization.sourceUserTextHash}`,
            `Relayed by: ${authorization.relayedByAgent}`
          ].join(`
`), {
            hiveID: authorization.hiveID,
            authorizationID: authorization.id,
            sourceSessionID: authorization.sourceUserSessionID,
            sourceUserMessageID: authorization.sourceUserMessageID
          });
        }
      });
      editor.add({
        name: "report",
        description: "Report worker progress, blockers, completion, or failure to the registered Hive channel.",
        input: reportInput,
        options: { namespace: "hive" },
        execute: async (rawInput, tool) => {
          const input = rawInput;
          const record = await ctx.storage.get(workerKey(tool.sessionID));
          if (!record)
            throw new Error("This session is not a Hive worker session");
          if (input.status === "blocked" && record.pendingQuestion?.blocking) {
            return text(`Blocked report suppressed because ${record.pendingQuestion.id} already represents this blocked state.`, { hiveID: record.hiveID, questionID: record.pendingQuestion.id, suppressed: true });
          }
          const reportParts = [
            `Hive report from ${record.agentName} [${input.status}]`,
            `${record.projectName}/${record.workspaceName}: ${oneLine(input.summary)}`
          ];
          if (input.commit)
            reportParts.push(`Commit: ${oneLine(input.commit)}`);
          if (input.todos?.length)
            reportParts.push(`TODOs: ${input.todos.map(oneLine).join("; ")}`);
          reportParts.push(`Open: ${openChamberLink(tool.sessionID, record.workspaceDirectory)}`);
          const report = {
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
            createdAt: Date.now()
          };
          await saveReport(ctx, report);
          const updated = { ...record, lastStatus: input.status, lastReportAt: report.createdAt };
          if (record.pendingQuestion?.status === "reply-queued")
            delete updated.pendingQuestion;
          await saveWorker(ctx, updated);
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
              reportStatus: input.status
            }
          });
          return text(`Reported ${input.status} to Hive ${record.hiveID}.`);
        }
      });
      editor.add({
        name: "sessions",
        description: "List worker sessions launched by a Hive with OpenChamber links.",
        input: sessionsInput,
        options: { namespace: "hive" },
        execute: async (rawInput, tool) => {
          const input = rawInput;
          const hives = await configuredHives(ctx);
          const hive = await selectHive(ctx, hives, tool.sessionID, input.hive);
          const workers = await ctx.storage.scan({ prefix: `hives/${hive.id}/workers/`, limit: 1000 });
          const records = workers.entries.map((entry) => entry.value).sort((left, right) => (right.lastDispatchAt ?? right.createdAt) - (left.lastDispatchAt ?? left.createdAt));
          if (records.length === 0)
            return text(`No worker sessions for ${hive.name}.`);
          return text(records.map((record) => `- ${record.agentName} in ${record.projectName}/${record.workspaceName}: ${record.sessionID} | dispatches: ${record.dispatchCount ?? 1} | last status: ${record.lastStatus ?? "not reported"}${record.pendingQuestion ? ` | ${record.pendingQuestion.status === "awaiting-controller" ? "awaiting controller" : "reply awaiting receipt"}: ${record.pendingQuestion.id}` : ""} | ${openChamberLink(record.sessionID, record.workspaceDirectory)}`).join(`
`));
        }
      });
    });
  }
});
export {
  src_default as default
};

//# debugId=6E21FECBF97910A164756E2164756E21
