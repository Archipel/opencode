import { describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { orderHomeSessions, type HomeSessionRecord } from "./home-session-order"
import { pendingHomeProjectDirectories } from "./home-project-discovery"
import type { Tab } from "@/context/tabs"
import { ServerConnection } from "@/context/server"

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

const mockTabs: Tab[] = []
const mockServer = ServerConnection.Key.make("http://localhost:1234")

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
    const result = orderHomeSessions(baseRecords, mockTabs, mockServer, () => false)
    expect(result.map((r) => r.session.id)).toEqual(["newest", "middle", "oldest"])
  })

  test("moves open-tab sessions to front, preserving recency within active partition", () => {
    const tabs: Tab[] = [{ type: "session", server: mockServer, sessionId: "middle" }]
    const result = orderHomeSessions(baseRecords, tabs, mockServer, () => false)
    expect(result.map((r) => r.session.id)).toEqual(["middle", "newest", "oldest"])
  })

  test("moves working sessions to front, preserving recency within active partition", () => {
    const isWorking = (id: string) => id === "oldest"
    const result = orderHomeSessions(baseRecords, mockTabs, mockServer, isWorking)
    expect(result.map((r) => r.session.id)).toEqual(["oldest", "newest", "middle"])
  })

  test("open tab takes precedence but both are active; recency within active partition", () => {
    const tabs: Tab[] = [{ type: "session", server: mockServer, sessionId: "middle" }]
    const isWorking = (id: string) => id === "oldest"
    const result = orderHomeSessions(baseRecords, tabs, mockServer, isWorking)
    // Both middle (open tab) and oldest (working) are active; newest is inactive
    // Active partition should be sorted by recency: middle (200) > oldest (100)
    expect(result.map((r) => r.session.id)).toEqual(["middle", "oldest", "newest"])
  })

  test("multiple active sessions sorted by recency within active partition", () => {
    const tabs: Tab[] = [
      { type: "session", server: mockServer, sessionId: "oldest" },
      { type: "session", server: mockServer, sessionId: "newest" },
    ]
    const result = orderHomeSessions(baseRecords, tabs, mockServer, () => false)
    // Active: newest (300), oldest (100) - sorted by recency
    // Inactive: middle (200)
    expect(result.map((r) => r.session.id)).toEqual(["newest", "oldest", "middle"])
  })

  test("inactive sessions preserve newest-first order after active partition", () => {
    const tabs: Tab[] = [{ type: "session", server: mockServer, sessionId: "middle" }]
    const result = orderHomeSessions(baseRecords, tabs, mockServer, () => false)
    // Active: middle
    // Inactive: newest (300), oldest (100) - sorted by recency
    expect(result.map((r) => r.session.id)).toEqual(["middle", "newest", "oldest"])
  })

  test("handles empty records array", () => {
    const result = orderHomeSessions([], mockTabs, mockServer, () => false)
    expect(result).toEqual([])
  })

  test("handles all sessions active", () => {
    const tabs: Tab[] = [
      { type: "session", server: mockServer, sessionId: "oldest" },
      { type: "session", server: mockServer, sessionId: "middle" },
      { type: "session", server: mockServer, sessionId: "newest" },
    ]
    const result = orderHomeSessions(baseRecords, tabs, mockServer, () => false)
    expect(result.map((r) => r.session.id)).toEqual(["newest", "middle", "oldest"])
  })

  test("handles sessions from different server (not active)", () => {
    const otherServer = ServerConnection.Key.make("http://localhost:5678")
    const tabs: Tab[] = [{ type: "session", server: otherServer, sessionId: "newest" }]
    const result = orderHomeSessions(baseRecords, tabs, mockServer, () => false)
    // Tab is for different server, so no sessions are active
    expect(result.map((r) => r.session.id)).toEqual(["newest", "middle", "oldest"])
  })
})
