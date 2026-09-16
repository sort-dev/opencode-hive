import { mkdir, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

const root = resolve(import.meta.dir, "..")
const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8")) as {
  version: string
}
const builtAt = new Date().toISOString()
const buildID = `${packageJson.version}-${builtAt.replaceAll(/[-:.TZ]/g, "").slice(0, 14)}`

await mkdir(resolve(root, "dist"), { recursive: true })
const result = await Bun.build({
  entrypoints: [resolve(root, "src/index.ts")],
  outdir: resolve(root, "dist"),
  target: "bun",
  format: "esm",
  packages: "external",
  sourcemap: "external",
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

await writeFile(
  resolve(root, "dist/build-info.json"),
  `${JSON.stringify({ version: packageJson.version, buildID, builtAt }, null, 2)}\n`,
)
console.log(`Built OpenCode Hive ${buildID}`)
