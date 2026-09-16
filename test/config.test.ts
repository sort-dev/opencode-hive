import { describe, expect, test } from "bun:test"
import { parseHiveConfig, resolveWorkspace } from "../src/config"

const path = "/tmp/example-hive/hive.json"

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
})
