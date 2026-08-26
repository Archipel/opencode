import type { Session } from "@opencode-ai/sdk/v2/client"
import { compareSessionTime } from "@/pages/layout/helpers"
import { DateTime } from "luxon"

export type HomeSessionGroup<T> = {
  id: "active" | "today" | "yesterday" | "older"
  title: string
  sessions: T[]
}

export function orderHomeSessions<T extends { session: Session }>(records: T[], isActive: (record: T) => boolean) {
  return [...records].sort((a, b) => {
    const aActive = isActive(a)
    const bActive = isActive(b)
    if (aActive !== bActive) return aActive ? -1 : 1
    return compareSessionTime(a.session, b.session)
  })
}

export function groupHomeSessions<T extends { session: Session }>(
  records: T[],
  translate: (
    key:
      | "sidebar.project.recentSessions"
      | "home.sessions.group.today"
      | "home.sessions.group.yesterday"
      | "home.sessions.group.older",
  ) => string,
  isActive: (record: T) => boolean,
  now: DateTime<boolean> = DateTime.local(),
): HomeSessionGroup<T>[] {
  const yesterday = now.minus({ days: 1 })
  const inactive = records.filter((record) => !isActive(record))
  const activeSessions = records.filter(isActive)
  const todaySessions = inactive.filter((record) =>
    DateTime.fromMillis(record.session.time.updated ?? record.session.time.created).hasSame(now, "day"),
  )
  const yesterdaySessions = inactive.filter((record) =>
    DateTime.fromMillis(record.session.time.updated ?? record.session.time.created).hasSame(yesterday, "day"),
  )
  const olderSessions = inactive.filter((record) => {
    const time = DateTime.fromMillis(record.session.time.updated ?? record.session.time.created)
    return !time.hasSame(now, "day") && !time.hasSame(yesterday, "day")
  })
  const olderTitle =
    activeSessions.length === 0 && todaySessions.length === 0 && yesterdaySessions.length === 0
      ? translate("sidebar.project.recentSessions")
      : translate("home.sessions.group.older")
  const groups: HomeSessionGroup<T>[] = [
    { id: "active", title: translate("sidebar.project.recentSessions"), sessions: activeSessions },
    { id: "today", title: translate("home.sessions.group.today"), sessions: todaySessions },
    { id: "yesterday", title: translate("home.sessions.group.yesterday"), sessions: yesterdaySessions },
    { id: "older", title: olderTitle, sessions: olderSessions },
  ]
  return groups.filter((group) => group.sessions.length > 0)
}
