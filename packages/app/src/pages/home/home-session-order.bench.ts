import { describe, expect, test } from "bun:test"
import { orderHomeSessions, type HomeSessionRecord } from "./home-session-order"
import type { Tab } from "@/context/tabs"
import { ServerConnection } from "@/context/server"
import type { Session } from "@opencode-ai/sdk/v2/client"

function createSession(id: string, directory: string, updated: number): Session {
  return {
    id,
    slug: id,
    projectID: "proj",
    directory,
    title: id,
    version: "",
    time: { created: updated, updated },
  }
}

function createRecord(id: string, directory: string, updated: number): HomeSessionRecord {
  return {
    session: createSession(id, directory, updated),
    project: { name: "test", worktree: directory, expanded: false },
    projectName: "test",
  }
}

function createTab(sessionId: string): Tab {
  return {
    type: "session",
    server: ServerConnection.Key.make("http://localhost:1234"),
    sessionId,
  }
}

function benchmark(name: string, fn: () => void, iterations = 1000): number {
  // Warmup
  for (let i = 0; i < 100; i++) fn()
  
  const start = performance.now()
  for (let i = 0; i < iterations; i++) fn()
  const end = performance.now()
  
  const avgMs = (end - start) / iterations
  console.log(`BENCHMARK ${name}: ${avgMs.toFixed(4)}ms avg over ${iterations} iterations`)
  return avgMs
}

describe("orderHomeSessions performance", () => {
  const server = ServerConnection.Key.make("http://localhost:1234")
  
  test("baseline: 64 sessions, no active", () => {
    const records: HomeSessionRecord[] = []
    for (let i = 0; i < 64; i++) {
      records.push(createRecord(`s${i}`, `/repo/${i}`, 1000 + i * 10))
    }
    const tabs: Tab[] = []
    const isWorking = () => false
    
    benchmark("64 sessions, no active", () => {
      orderHomeSessions(records, tabs, server, isWorking)
    })
  })
  
  test("baseline: 64 sessions, 10 active (open tabs)", () => {
    const records: HomeSessionRecord[] = []
    for (let i = 0; i < 64; i++) {
      records.push(createRecord(`s${i}`, `/repo/${i}`, 1000 + i * 10))
    }
    const tabs: Tab[] = []
    for (let i = 0; i < 10; i++) {
      tabs.push(createTab(`s${i * 6}`)) // Spread active sessions across the list
    }
    const isWorking = () => false
    
    benchmark("64 sessions, 10 open tabs", () => {
      orderHomeSessions(records, tabs, server, isWorking)
    })
  })
  
  test("baseline: 64 sessions, 10 active (working)", () => {
    const records: HomeSessionRecord[] = []
    for (let i = 0; i < 64; i++) {
      records.push(createRecord(`s${i}`, `/repo/${i}`, 1000 + i * 10))
    }
    const tabs: Tab[] = []
    const workingIds = new Set<string>()
    for (let i = 0; i < 10; i++) {
      workingIds.add(`s${i * 6}`)
    }
    const isWorking = (id: string) => workingIds.has(id)
    
    benchmark("64 sessions, 10 working", () => {
      orderHomeSessions(records, tabs, server, isWorking)
    })
  })
  
  test("baseline: 64 sessions, mixed active (tabs + working)", () => {
    const records: HomeSessionRecord[] = []
    for (let i = 0; i < 64; i++) {
      records.push(createRecord(`s${i}`, `/repo/${i}`, 1000 + i * 10))
    }
    const tabs: Tab[] = []
    for (let i = 0; i < 5; i++) {
      tabs.push(createTab(`s${i * 10}`))
    }
    const workingIds = new Set<string>()
    for (let i = 0; i < 5; i++) {
      workingIds.add(`s${i * 10 + 3}`)
    }
    const isWorking = (id: string) => workingIds.has(id)
    
    benchmark("64 sessions, 5 tabs + 5 working", () => {
      orderHomeSessions(records, tabs, server, isWorking)
    })
  })
  
  test("baseline: 64 sessions, all active", () => {
    const records: HomeSessionRecord[] = []
    for (let i = 0; i < 64; i++) {
      records.push(createRecord(`s${i}`, `/repo/${i}`, 1000 + i * 10))
    }
    const tabs: Tab[] = []
    for (let i = 0; i < 64; i++) {
      tabs.push(createTab(`s${i}`))
    }
    const isWorking = () => false
    
    benchmark("64 sessions, all active", () => {
      orderHomeSessions(records, tabs, server, isWorking)
    })
  })
})