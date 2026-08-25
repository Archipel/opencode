import { describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2/client"
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
