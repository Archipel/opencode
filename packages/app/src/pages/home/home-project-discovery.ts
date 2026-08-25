import type { Session } from "@opencode-ai/sdk/v2/client"
import { compareSessionTime } from "@/pages/layout/helpers"
import { pathKey } from "@/utils/path-key"

// Directories from server sessions that are not registered projects yet, ordered
// oldest-representative-first so prepending via projects.open() yields newest-first.
export function pendingHomeProjectDirectories(sessions: Session[], registered: string[]) {
  const known = new Set(registered.map(pathKey))
  const seen = new Set<string>()
  const pending: string[] = []
  for (const session of [...sessions].sort(compareSessionTime)) {
    const directory = pathKey(session.directory)
    if (known.has(directory) || !seen.add(directory)) continue
    known.add(directory)
    pending.push(session.directory)
  }
  return pending.reverse()
}
