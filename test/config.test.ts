import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { discoverHiveConfigPaths, parseHiveConfig, resolveWorkspace } from "../src/config"

const path = "/tmp/example-hive/hive.json"
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

function config() {
  return parseHiveConfig(
    {
      version: 1,
      id: "test-hive",
      agents: {
        Fooagent: { openCodeAgent: "build" },
      },
      projects: {
        brikk: {
          defaultWorkspace: "main",
          workspaces: [
            {
              name: "main",
              directory: "../brikk-main",
              branch: "main",
              aliases: ["release"],
              defaultAgent: "Fooagent",
            },
            {
              name: "auth",
              directory: "../brikk-auth",
              branch: "feature/auth",
            },
          ],
        },
      },
    },
    path,
  )
}

describe("Hive config", () => {
  test("resolves a project default", () => {
    expect(resolveWorkspace(config(), "brikk").reference).toBe("brikk/main")
  })

  test("resolves names, branches, and aliases", () => {
    const hive = config()
    expect(resolveWorkspace(hive, "brikk/auth").workspace.name).toBe("auth")
    expect(resolveWorkspace(hive, "brikk/feature/auth").workspace.name).toBe("auth")
    expect(resolveWorkspace(hive, "brikk/release").workspace.name).toBe("main")
  })

  test("resolves workspace paths relative to hive.json", () => {
    expect(resolveWorkspace(config(), "brikk/main").workspace.directory).toBe("/tmp/brikk-main")
  })

  test("rejects unknown default agents", () => {
    expect(() =>
      parseHiveConfig(
        {
          version: 1,
          id: "broken",
          agents: { Fooagent: {} },
          projects: {
            brikk: {
              workspaces: [
                { name: "main", directory: "/tmp/brikk", defaultAgent: "Missing" },
              ],
            },
          },
        },
        path,
      ),
    ).toThrow("unknown agent Missing")
  })

  test("discovers each supported local config form", async () => {
    for (const relative of [".hive/config.json", ".hive.json", "hive.json"]) {
      const root = await mkdtemp(join(tmpdir(), "hive-discovery-"))
      temporaryDirectories.push(root)
      await mkdir(join(root, ".hive"), { recursive: true })
      await writeFile(join(root, relative), "{}")
      expect(await discoverHiveConfigPaths(root, root)).toEqual([join(root, relative)])
    }
  })

  test("searches ancestors only through the project boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-boundary-"))
    temporaryDirectories.push(root)
    const project = join(root, "project")
    const nested = join(project, "packages", "app")
    await mkdir(nested, { recursive: true })
    await writeFile(join(project, "hive.json"), "{}")
    expect(await discoverHiveConfigPaths(nested, project)).toEqual([join(project, "hive.json")])

    await rm(join(project, "hive.json"))
    await writeFile(join(root, "hive.json"), "{}")
    expect(await discoverHiveConfigPaths(nested, project)).toEqual([])
  })

  test("rejects competing discovered configs", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-ambiguous-"))
    temporaryDirectories.push(root)
    await mkdir(join(root, ".hive"), { recursive: true })
    await writeFile(join(root, ".hive", "config.json"), "{}")
    await writeFile(join(root, "hive.json"), "{}")
    await expect(discoverHiveConfigPaths(root, root)).rejects.toThrow("Multiple Hive configs found")
  })
})
