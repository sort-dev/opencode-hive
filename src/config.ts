import { stat } from "node:fs/promises"
import { dirname, isAbsolute, resolve } from "node:path"

export type HivePermissionMode = "ask" | "auto"

export interface HiveAgent {
  openCodeAgent: string
  model?: string
  instructions?: string
  permissionMode?: HivePermissionMode
}

export interface HiveWorkspace {
  name: string
  directory: string
  branch?: string
  defaultAgent?: string
  aliases: string[]
  permissionMode?: HivePermissionMode
}

export interface HiveProject {
  defaultWorkspace?: string
  workspaces: HiveWorkspace[]
}

export interface HiveChannel {
  defaultAgent?: string
  contextMessages: number
}

export interface HiveConfig {
  version: 1
  id: string
  name: string
  permissionMode: HivePermissionMode
  channel: HiveChannel
  agents: Record<string, HiveAgent>
  projects: Record<string, HiveProject>
  configPath: string
  directory: string
}

export interface ResolvedWorkspace {
  projectName: string
  workspace: HiveWorkspace
  reference: string
}

type JsonObject = Record<string, unknown>

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as JsonObject
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`)
  }
  return value
}

function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : string(value, label)
}

function optionalPermissionMode(value: unknown, label: string): HivePermissionMode | undefined {
  if (value === undefined) return undefined
  if (value !== "ask" && value !== "auto") throw new Error(`${label} must be ask or auto`)
  return value
}

function stringArray(value: unknown, label: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return value.map((item, index) => string(item, `${label}[${index}]`))
}

function parseAgent(value: unknown, label: string): HiveAgent {
  const input = object(value, label)
  return {
    openCodeAgent: optionalString(input.openCodeAgent, `${label}.openCodeAgent`) ?? "build",
    model: optionalString(input.model, `${label}.model`),
    instructions: optionalString(input.instructions, `${label}.instructions`),
    permissionMode: optionalPermissionMode(input.permissionMode, `${label}.permissionMode`),
  }
}

function parseWorkspace(value: unknown, label: string, baseDirectory: string): HiveWorkspace {
  const input = object(value, label)
  const configuredDirectory = string(input.directory, `${label}.directory`)
  return {
    name: string(input.name, `${label}.name`),
    directory: resolve(baseDirectory, configuredDirectory),
    branch: optionalString(input.branch, `${label}.branch`),
    defaultAgent: optionalString(input.defaultAgent, `${label}.defaultAgent`),
    aliases: stringArray(input.aliases, `${label}.aliases`),
    permissionMode: optionalPermissionMode(input.permissionMode, `${label}.permissionMode`),
  }
}

function parseProject(value: unknown, label: string, baseDirectory: string): HiveProject {
  const input = object(value, label)
  if (!Array.isArray(input.workspaces) || input.workspaces.length === 0) {
    throw new Error(`${label}.workspaces must contain at least one workspace`)
  }
  const workspaces = input.workspaces.map((workspace, index) =>
    parseWorkspace(workspace, `${label}.workspaces[${index}]`, baseDirectory),
  )
  const names = new Set<string>()
  for (const workspace of workspaces) {
    if (names.has(workspace.name)) throw new Error(`${label} has duplicate workspace ${workspace.name}`)
    names.add(workspace.name)
  }
  return {
    defaultWorkspace: optionalString(input.defaultWorkspace, `${label}.defaultWorkspace`),
    workspaces,
  }
}

export function parseHiveConfig(value: unknown, configPath: string): HiveConfig {
  const input = object(value, configPath)
  if (input.version !== 1) throw new Error(`${configPath}.version must be 1`)

  const agentsInput = object(input.agents, `${configPath}.agents`)
  const agents = Object.fromEntries(
    Object.entries(agentsInput).map(([name, agent]) => [name, parseAgent(agent, `agents.${name}`)]),
  )
  if (Object.keys(agents).length === 0) throw new Error(`${configPath}.agents must not be empty`)

  const configDirectory = dirname(configPath)
  const projectsInput = object(input.projects, `${configPath}.projects`)
  const projects = Object.fromEntries(
    Object.entries(projectsInput).map(([name, project]) => [
      name,
      parseProject(project, `projects.${name}`, configDirectory),
    ]),
  )
  if (Object.keys(projects).length === 0) throw new Error(`${configPath}.projects must not be empty`)

  for (const [projectName, project] of Object.entries(projects)) {
    if (
      project.defaultWorkspace &&
      !project.workspaces.some((workspace) => workspace.name === project.defaultWorkspace)
    ) {
      throw new Error(`projects.${projectName}.defaultWorkspace does not name a workspace`)
    }
    for (const workspace of project.workspaces) {
      if (workspace.defaultAgent && !agents[workspace.defaultAgent]) {
        throw new Error(
          `projects.${projectName}/${workspace.name} references unknown agent ${workspace.defaultAgent}`,
        )
      }
    }
  }

  const channelInput = input.channel === undefined ? {} : object(input.channel, `${configPath}.channel`)
  const contextMessages = channelInput.contextMessages ?? 12
  if (!Number.isInteger(contextMessages) || Number(contextMessages) < 0 || Number(contextMessages) > 100) {
    throw new Error(`${configPath}.channel.contextMessages must be an integer from 0 to 100`)
  }
  const defaultAgent = optionalString(channelInput.defaultAgent, `${configPath}.channel.defaultAgent`)
  if (defaultAgent && !agents[defaultAgent]) {
    throw new Error(`${configPath}.channel.defaultAgent references unknown agent ${defaultAgent}`)
  }

  const id = string(input.id, `${configPath}.id`)
  return {
    version: 1,
    id,
    name: optionalString(input.name, `${configPath}.name`) ?? id,
    permissionMode: optionalPermissionMode(input.permissionMode, `${configPath}.permissionMode`) ?? "ask",
    channel: { defaultAgent, contextMessages: Number(contextMessages) },
    agents,
    projects,
    configPath,
    directory: configDirectory,
  }
}

export async function loadHiveConfig(configPath: string): Promise<HiveConfig> {
  const absolutePath = isAbsolute(configPath) ? configPath : resolve(configPath)
  const file = Bun.file(absolutePath)
  if (!(await file.exists())) throw new Error(`Hive config does not exist: ${absolutePath}`)
  return parseHiveConfig(await file.json(), absolutePath)
}

export function resolveWorkspace(config: HiveConfig, reference: string): ResolvedWorkspace {
  const slash = reference.indexOf("/")
  const projectName = slash === -1 ? reference : reference.slice(0, slash)
  const selector = slash === -1 ? undefined : reference.slice(slash + 1)
  const project = config.projects[projectName]
  if (!project) throw new Error(`Unknown Hive project: ${projectName}`)

  let matches: HiveWorkspace[]
  if (!selector) {
    if (project.defaultWorkspace) {
      matches = project.workspaces.filter((workspace) => workspace.name === project.defaultWorkspace)
    } else if (project.workspaces.length === 1) {
      matches = project.workspaces
    } else {
      throw new Error(
        `${projectName} has multiple workspaces; use ${projectName}/<workspace-or-branch>`,
      )
    }
  } else {
    matches = project.workspaces.filter(
      (workspace) =>
        workspace.name === selector || workspace.branch === selector || workspace.aliases.includes(selector),
    )
  }

  if (matches.length === 0) throw new Error(`Unknown Hive workspace: ${reference}`)
  if (matches.length > 1) throw new Error(`Ambiguous Hive workspace: ${reference}`)
  return { projectName, workspace: matches[0], reference: `${projectName}/${matches[0].name}` }
}

export async function assertWorkspaceDirectory(workspace: HiveWorkspace): Promise<void> {
  let info
  try {
    info = await stat(workspace.directory)
  } catch {
    throw new Error(`Workspace directory does not exist: ${workspace.directory}`)
  }
  if (!info.isDirectory()) throw new Error(`Workspace path is not a directory: ${workspace.directory}`)
}

export function configPathsFromOptions(options: Readonly<Record<string, unknown>>, location: string): string[] {
  const configured = options.configs
  if (configured !== undefined) {
    if (!Array.isArray(configured) || configured.some((path) => typeof path !== "string")) {
      throw new Error("Hive plugin option 'configs' must be an array of paths")
    }
    return configured.map((path) => {
      if (!isAbsolute(path)) throw new Error(`Hive config paths in plugin options must be absolute: ${path}`)
      return path
    })
  }
  return [resolve(location, "hive.json")]
}
