import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { tmpdir } from "../../fixture/fixture"

describe("native lib cleanup", () => {
  test("reaps unmapped extracted libraries and keeps mapped ones", async () => {
    await using tmp = await tmpdir()
    const previousTmpdir = process.env.TMPDIR
    process.env.TMPDIR = tmp.path
    const fake = (name: string) => path.join(tmp.path, name)
    await fs.writeFile(fake(".aaaa0000aaaa0000-00000009.so"), "stale")
    const mappedPath = fake(".bbbb1111bbbb1111-0000000a.so")
    await fs.writeFile(mappedPath, "mapped")
    await fs.writeFile(fake("unrelated.txt"), "keep")
    const mapping = Bun.mmap(mappedPath)

    await import("@/cli/cmd/run/native-lib-cleanup")

    const exists = (file: string) => fs.access(file).then(() => true, () => false)
    expect(await exists(fake(".aaaa0000aaaa0000-00000009.so"))).toBe(false)
    expect(await exists(mappedPath)).toBe(true)
    expect(await exists(fake("unrelated.txt"))).toBe(true)

    if (previousTmpdir === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = previousTmpdir
  })
})
