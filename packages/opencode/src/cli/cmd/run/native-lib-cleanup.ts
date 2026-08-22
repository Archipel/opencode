// Bun standalone executables extract embedded native libraries to fresh
// `<tmpdir>/.<hash>-<index>.so` files on every dlopen and never delete them,
// so each launch leaks ~14 MB (libopentui) plus any lazily dlopen'd modules
// until /tmp fills up. The extraction happens while the module performing
// the dlopen is evaluated, so this side-effectful module must be imported
// before anything else loads @opentui/core.
//
// Unlinking a mapped library is safe on Linux and macOS: the inode survives
// for the existing mapping and the library is never re-opened. On Windows
// unlinking an in-use DLL fails and is ignored. Files left behind by killed
// processes are reaped on the next Linux launch when no live process has
// them mapped.
import fsSync from "node:fs"
import fs from "fs/promises"
import os from "os"
import path from "path"

const EXTRACTED_LIB = /^\.[0-9a-f]+-[0-9]{8}\.so$/
const loadedAt = Date.now()

async function extractedLibs(): Promise<string[]> {
  const dir = os.tmpdir()
  const entries = await fs.readdir(dir).catch(() => [])
  return entries.filter((entry) => EXTRACTED_LIB.test(entry)).map((entry) => path.join(dir, entry))
}

async function mappedLibs(): Promise<Set<string>> {
  const mapped = new Set<string>()
  if (process.platform !== "linux") return mapped
  const dir = os.tmpdir()
  const escaped = dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const pattern = new RegExp(`${escaped}/\\.[^\\s]+\\.so`, "g")
  const pids = (await fs.readdir("/proc").catch(() => [])).filter((pid) => /^[0-9]+$/.test(pid))
  await Promise.all(
    pids.map(async (pid) => {
      const maps = await fs.readFile(`/proc/${pid}/maps`, "utf8").catch(() => "")
      for (const match of maps.matchAll(pattern)) {
        mapped.add(match[0])
      }
    }),
  )
  return mapped
}

async function ownedByCurrentUser(file: string): Promise<boolean> {
  const stat = await fs.stat(file).catch(() => undefined)
  if (!stat?.isFile()) return false
  if (process.platform === "win32") return true
  return stat.uid === process.getuid?.()
}

async function unlinkMappedCheck(): Promise<void> {
  const [files, mapped] = await Promise.all([extractedLibs(), mappedLibs()])
  await Promise.all(
    files
      .filter((file) => !mapped.has(file))
      .map(async (file) => {
        if (!(await ownedByCurrentUser(file))) return
        await fs.unlink(file).catch(() => {})
      }),
  )
}

const before = new Set(await extractedLibs())
await import("@opentui/core")
for (const file of await extractedLibs()) {
  if (!before.has(file)) {
    await fs.unlink(file).catch(() => {})
  }
}

if (process.platform === "linux") {
  await unlinkMappedCheck()
}

function sweepNewlyExtracted(): void {
  const dir = os.tmpdir()
  let entries: string[]
  try {
    entries = fsSync.readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    if (!EXTRACTED_LIB.test(entry)) continue
    const file = path.join(dir, entry)
    try {
      const stat = fsSync.statSync(file)
      if (!stat.isFile() || stat.mtimeMs < loadedAt) continue
      fsSync.unlinkSync(file)
    } catch {}
  }
}

process.on("exit", sweepNewlyExtracted)

for (const signal of ["SIGTERM", "SIGHUP"] as const) {
  const handler = () => {
    sweepNewlyExtracted()
    process.removeListener(signal, handler)
    process.kill(process.pid, signal)
  }
  process.on(signal, handler)
}
