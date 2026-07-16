const { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } = require("fs")
const { dirname, isAbsolute, join, relative, resolve } = require("path")

const root = __dirname
const exclude = new Set(["mock"])
const srcDir = join(root, "plugins")
const dstDir = join(root, "src-tauri", "resources", "bundled_plugins")

rmSync(dstDir, { recursive: true, force: true })
mkdirSync(dstDir, { recursive: true })
writeFileSync(join(dstDir, ".gitkeep"), "")

const plugins = readdirSync(srcDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && !exclude.has(d.name))
  .map((d) => d.name)

function copyPluginFile(id, relativePath) {
  if (typeof relativePath !== "string" || relativePath.length === 0) {
    throw new Error(`Plugin ${id} declares an empty resource path`)
  }

  const pluginDir = join(srcDir, id)
  const sourcePath = resolve(pluginDir, relativePath)
  const pathWithinPlugin = relative(pluginDir, sourcePath)
  if (pathWithinPlugin.startsWith("..") || isAbsolute(pathWithinPlugin)) {
    throw new Error(`Plugin ${id} resource escapes its directory: ${relativePath}`)
  }

  const destinationPath = join(dstDir, id, pathWithinPlugin)
  mkdirSync(dirname(destinationPath), { recursive: true })
  cpSync(sourcePath, destinationPath)
}

for (const id of plugins) {
  const manifestPath = join(srcDir, id, "plugin.json")
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
  for (const relativePath of new Set(["plugin.json", manifest.entry, manifest.icon])) {
    copyPluginFile(id, relativePath)
  }
}

console.log(`Bundled ${plugins.length} plugins: ${plugins.join(", ")}`)
