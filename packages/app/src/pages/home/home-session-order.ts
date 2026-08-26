import type { Session } from "@opencode-ai/sdk/v2/client"
import type { Tab } from "@/context/tabs"
import { ServerConnection } from "@/context/server"
import { compareSessionTime } from "@/pages/layout/helpers"
import type { HomeSessionRecord } from "./home-sessions-controller"

export type { HomeSessionRecord }

function hasOpenTab(tabs: Tab[], server: ServerConnection.Key, session: Session) {
  return tabs.some((tab) => tab.type === "session" && tab.server === server && tab.sessionId === session.id)
}

export function orderHomeSessions(
  records: HomeSessionRecord[],
  tabs: Tab[],
  server: ServerConnection.Key,
  isWorking: (sessionId: string) => boolean,
): HomeSessionRecord[] {
  const active = new Set<string>()
  for (const record of records) {
    if (hasOpenTab(tabs, server, record.session) || isWorking(record.session.id)) {
      active.add(record.session.id)
    }
  }
  return [...records].sort((a, b) => {
    const aActive = active.has(a.session.id)
    const bActive = active.has(b.session.id)
    if (aActive !== bActive) return aActive ? -1 : 1
    return compareSessionTime(a.session, b.session)
  })
}