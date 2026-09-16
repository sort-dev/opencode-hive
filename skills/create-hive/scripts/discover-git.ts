#!/usr/bin/env bun

import { execFile } from "node:child_process"
import { constants } from "node:fs"
import { access, readdir, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, join, resolve } from "node:path"
import { promisify } from "node:util"

const exec = promisify(execFile)
const ignoredDirectories = new Set([
  ".git",
  ".idea",
  ".gradle",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
])
const maxDepth = 5
const maxVisitedDirectories = 20_000

interface Worktree {
  path: string
  branch?: string
  head?: string
  detached?: boolean
}

interface Repository {
  name: string
  commonGitDirectory: string
  worktrees: Worktree[]
}

function expandPath(path: string): string {
  if (path === "~") return homedir()
  if (path.startsWith("~/")) return join(homedir(), path.slice(2))
  return resolve(path)
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

async function git(path: string, args: string[]): Promise<string> {
  const result = await exec("git", ["-C", path, ...args], { maxBuffer: 4 * 1024 * 1024 })
  return result.stdout.trim()
}

function parseWorktrees(value: string): Worktree[] {
  return value
    .split(/\n\s*\n/)
    .map((block) => {
      const worktree: Worktree = { path: "" }
      for (const line of block.split("\n")) {
        if (line.startsWith("worktree ")) worktree.path = line.slice("worktree ".length)
        else if (line.startsWith("HEAD ")) worktree.head = line.slice("HEAD ".length)
        else if (line.startsWith("branch refs/heads/")) worktree.branch = line.slice("branch refs/heads/".length)
        else if (line === "detached") worktree.detached = true
      }
      return worktree
    })
    .filter((worktree) => worktree.path)
}

async function inspectRepository(path: string): Promise<Repository> {
  const topLevel = await git(path, ["rev-parse", "--show-toplevel"])
  const common = await git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
  const worktrees = parseWorktrees(await git(path, ["worktree", "list", "--porcelain"]))
  return {
    name: basename(topLevel),
    commonGitDirectory: common,
    worktrees,
  }
}

let visited = 0

async function findRepositories(path: string, depth: number, found: Set<string>): Promise<void> {
  if (visited++ >= maxVisitedDirectories) {
    throw new Error(`Search stopped after ${maxVisitedDirectories} directories; use narrower roots`)
  }
  let info
  try {
    info = await stat(path)
  } catch {
    return
  }
  if (!info.isDirectory()) return
  if (await exists(join(path, ".git"))) {
    found.add(path)
    return
  }
  if (depth >= maxDepth) return

  let entries
  try {
    entries = await readdir(path, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (ignoredDirectories.has(entry.name)) continue
    if (entry.name.startsWith(".")) continue
    await findRepositories(join(path, entry.name), depth + 1, found)
  }
}

const requested = process.argv.slice(2)
if (requested.length === 0) {
  console.error("Usage: discover-git.ts <project-or-approved-search-root> [...]")
  process.exit(2)
}

const candidates = new Set<string>()
for (const input of requested.map(expandPath)) await findRepositories(input, 0, candidates)

const repositories = new Map<string, Repository>()
for (const candidate of candidates) {
  try {
    const repository = await inspectRepository(candidate)
    repositories.set(repository.commonGitDirectory, repository)
  } catch (error) {
    console.error(`Skipping ${candidate}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

console.log(JSON.stringify([...repositories.values()], null, 2))
