import { describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { DateTime } from "luxon"
import { groupHomeSessions, orderHomeSessions } from "./home-session-order"
import type { HomeSessionRecord } from "./home-sessions-controller"
import { pendingHomeProjectDirectories } from "./home-project-discovery"

function session(input: { id: string; directory: string; updated: number }): Session {
  return {
    id: input.id,
    slug: input.id,
    projectID: "proj",
    directory: input.directory,
    title: input.id,
    version: "",
    time: { created: input.updated, updated: input.updated },
  }
}

function record(input: { id: string; directory: string; updated: number }): HomeSessionRecord {
  const s = session(input)
  return { session: s, project: { name: "test", worktree: input.directory, expanded: false }, projectName: "test" }
}

// Mirrors ServerProjects.open(), which prepends new worktrees.
function prependAll(directories: string[], initial: string[] = []) {
  return directories.reduce((list, directory) => [directory, ...list], initial)
}

describe("pendingHomeProjectDirectories", () => {
  test("registers nothing when every session directory is already a project", () => {
    const sessions = [
      session({ id: "s1", directory: "/repo/a", updated: 200 }),
      session({ id: "s2", directory: "/repo/b", updated: 100 }),
    ]

    expect(pendingHomeProjectDirectories(sessions, ["/repo/a", "/repo/b"])).toEqual([])
  })

  test("yields newest-session-first project order despite open() prepending", () => {
    const sessions = [
      session({ id: "s1", directory: "/repo/a", updated: 300 }),
      session({ id: "s2", directory: "/repo/b", updated: 200 }),
      session({ id: "s3", directory: "/repo/c", updated: 100 }),
    ]

    expect(prependAll(pendingHomeProjectDirectories(sessions, []))).toEqual(["/repo/a", "/repo/b", "/repo/c"])
  })

  test("positions a directory by its newest session, not its oldest", () => {
    const sessions = [
      session({ id: "old", directory: "/repo/d", updated: 50 }),
      session({ id: "mid", directory: "/repo/e", updated: 200 }),
      session({ id: "new", directory: "/repo/d", updated: 500 }),
    ]

    expect(prependAll(pendingHomeProjectDirectories(sessions, []))).toEqual(["/repo/d", "/repo/e"])
  })

  test("ignores sessions under a directory already covered by a project sandbox", () => {
    // Caller passes worktree + sandboxes flattened, so the sandbox dir counts as registered.
    const sessions = [session({ id: "s1", directory: "/repo/worktrees/wt1", updated: 100 })]

    expect(pendingHomeProjectDirectories(sessions, ["/repo", "/repo/worktrees/wt1"])).toEqual([])
    expect(pendingHomeProjectDirectories(sessions, [])).toEqual(["/repo/worktrees/wt1"])
  })

  test("normalizes equivalent paths against registered projects", () => {
    const sessions = [session({ id: "s1", directory: "/repo/", updated: 100 })]

    expect(pendingHomeProjectDirectories(sessions, ["/repo"])).toEqual([])
  })

  test("returns empty without sessions", () => {
    expect(pendingHomeProjectDirectories([], [])).toEqual([])
  })
})

describe("orderHomeSessions", () => {
  const baseRecords = [
    record({ id: "oldest", directory: "/repo/a", updated: 100 }),
    record({ id: "middle", directory: "/repo/b", updated: 200 }),
    record({ id: "newest", directory: "/repo/c", updated: 300 }),
  ]

  test("preserves newest-first order when no sessions are active", () => {
    const result = orderHomeSessions(baseRecords, () => false)
    expect(result.map((r) => r.session.id)).toEqual(["newest", "middle", "oldest"])
  })

  test("moves open-tab sessions to front, preserving recency within active partition", () => {
    const result = orderHomeSessions(baseRecords, (record) => record.session.id === "middle")
    expect(result.map((r) => r.session.id)).toEqual(["middle", "newest", "oldest"])
  })

  test("moves working sessions to front, preserving recency within active partition", () => {
    const result = orderHomeSessions(baseRecords, (record) => record.session.id === "oldest")
    expect(result.map((r) => r.session.id)).toEqual(["oldest", "newest", "middle"])
  })

  test("open tab takes precedence but both are active; recency within active partition", () => {
    const result = orderHomeSessions(baseRecords, (record) => ["middle", "oldest"].includes(record.session.id))
    // Both middle (open tab) and oldest (working) are active; newest is inactive
    // Active partition should be sorted by recency: middle (200) > oldest (100)
    expect(result.map((r) => r.session.id)).toEqual(["middle", "oldest", "newest"])
  })

  test("multiple active sessions sorted by recency within active partition", () => {
    const result = orderHomeSessions(baseRecords, (record) => ["oldest", "newest"].includes(record.session.id))
    // Active: newest (300), oldest (100) - sorted by recency
    // Inactive: middle (200)
    expect(result.map((r) => r.session.id)).toEqual(["newest", "oldest", "middle"])
  })

  test("inactive sessions preserve newest-first order after active partition", () => {
    const result = orderHomeSessions(baseRecords, (record) => record.session.id === "middle")
    // Active: middle
    // Inactive: newest (300), oldest (100) - sorted by recency
    expect(result.map((r) => r.session.id)).toEqual(["middle", "newest", "oldest"])
  })

  test("handles empty records array", () => {
    const result = orderHomeSessions([], () => false)
    expect(result).toEqual([])
  })

  test("handles all sessions active", () => {
    const result = orderHomeSessions(baseRecords, () => true)
    expect(result.map((r) => r.session.id)).toEqual(["newest", "middle", "oldest"])
  })

  test("groups an older active session before a newer inactive session", () => {
    const now = DateTime.local(2026, 8, 26, 12)
    const records = [
      record({ id: "inactive", directory: "/repo/a", updated: now.toMillis() }),
      record({ id: "active", directory: "/repo/b", updated: now.minus({ days: 3 }).toMillis() }),
    ]
    const groups = groupHomeSessions(records, (key) => key, (item) => item.session.id === "active", now)

    expect(groups.map((group) => group.id)).toEqual(["active", "today"])
    expect(groups.flatMap((group) => group.sessions.map((item) => item.session.id))).toEqual(["active", "inactive"])
  })
})
