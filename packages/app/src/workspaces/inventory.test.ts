import { describe, expect, test } from "bun:test"
import { QueryClient } from "@tanstack/solid-query"
import type { WorktreeDirectory } from "@opencode/client/promise"
import { createWorktreeInventory, withWorktreeInventory, worktreeInventoryKey } from "./inventory"
import { ServerScope } from "@/runtime/server/scope"
import { normalizeProjectInfo, updateProjectInfo } from "@/runtime/server/global-sync/utils"

function setup(list: (directory: string) => Promise<WorktreeDirectory[]>) {
  const client = new QueryClient()
  const discovery = Promise.withResolvers<WorktreeDirectory[]>()
  const discoveries: string[] = []
  const calls: string[] = []
  const updates: Array<[string, WorktreeDirectory[]]> = []
  const inventory = createWorktreeInventory({
    scope: ServerScope.local,
    queryClient: client,
    api: () => ({
      list: (input) => {
        const directory = input.projectID
        calls.push(directory)
        return list(directory)
      },
      discover: (input) => {
        discoveries.push(input.projectID)
        return discovery.promise
      },
    }),
    updated: (directory, items) => {
      updates.push([directory, items])
    },
  })
  return { client, calls, updates, inventory, discovery, discoveries }
}

describe("createWorktreeInventory", () => {
  test("lists a project, shares in-flight work, and publishes each result", async () => {
    const gate = Promise.withResolvers<void>()
    const setupResult = setup(async (directory) => {
      await gate.promise
      return [{ directory }, { directory: `${directory}/feature`, strategy: "git" }]
    })
    const first = setupResult.inventory.list("/repo")
    const second = setupResult.inventory.list("/repo")
    expect(setupResult.calls).toEqual(["/repo"])
    gate.resolve()
    expect(await first).toHaveLength(2)
    expect(await second).toHaveLength(2)
    await setupResult.inventory.list("/repo")
    expect(setupResult.calls).toEqual(["/repo", "/repo"])
    expect(setupResult.updates).toEqual([
      ["/repo", [{ directory: "/repo" }, { directory: "/repo/feature", strategy: "git" }]],
      ["/repo", [{ directory: "/repo" }, { directory: "/repo/feature", strategy: "git" }]],
    ])
    expect(setupResult.inventory.cached("/repo")).toHaveLength(2)
    expect(setupResult.discoveries).toEqual([])
    setupResult.client.clear()
  })

  test("list reads saved inventory without discovery", async () => {
    const setupResult = setup(async (directory) => [{ directory }])
    await setupResult.inventory.list("/opened")
    expect(setupResult.calls).toEqual(["/opened"])
    expect(setupResult.discoveries).toEqual([])
    setupResult.client.clear()
  })

  test("a failed list is not cached and never rejects the caller", async () => {
    let fail = true
    const setupResult = setup(async (directory) => {
      if (fail) throw new Error("Location unavailable")
      return [{ directory }]
    })
    expect(await setupResult.inventory.list("/repo")).toBeUndefined()
    expect(setupResult.inventory.cached("/repo")).toBeUndefined()
    fail = false
    expect(await setupResult.inventory.list("/repo")).toEqual([{ directory: "/repo" }])
    expect(setupResult.calls).toEqual(["/repo", "/repo"])
    setupResult.client.clear()
  })

  test("keys are partitioned by server and use opaque project IDs", () => {
    const remote = "https://remote.example" as typeof ServerScope.local
    expect(worktreeInventoryKey(ServerScope.local, "project")).not.toEqual(
      worktreeInventoryKey(ServerScope.local, "project/"),
    )
    expect(worktreeInventoryKey(ServerScope.local, "/repo")).not.toEqual(worktreeInventoryKey(remote, "/repo"))
  })

  test("discover returns and caches one project's latest saved inventory", async () => {
    const rows = [{ directory: "/repo" }]
    const result = setup(async () => [...rows])
    expect(await result.inventory.list("project")).toEqual(rows)
    const pending = result.inventory.discover("project")
    rows.push({ directory: "/external" })
    result.discovery.resolve([...rows])
    expect(await pending).toEqual(rows)
    expect(result.calls).toEqual(["project"])
    expect(result.discoveries).toEqual(["project"])
    result.client.clear()
  })
})

describe("withWorktreeInventory", () => {
  const metadata = {
    id: "project",
    canonical: "/repo",
    name: "Before",
    time: { created: 1, updated: 1 },
    sandboxes: [],
  }

  test("derives the workspace list from the inventory, excluding the project root", () => {
    const worktrees = [
      { directory: "/repo/" },
      { directory: "/repo/feature", strategy: "git" },
      { directory: "/elsewhere" },
    ]
    expect(withWorktreeInventory(normalizeProjectInfo(metadata), worktrees)).toMatchObject({
      worktree: "/repo",
      sandboxes: ["/repo/feature", "/elsewhere"],
      worktrees,
    })
  })

  test("leaves metadata untouched without an inventory and survives metadata updates", () => {
    const project = normalizeProjectInfo(metadata)
    expect(withWorktreeInventory(project, undefined)).toBe(project)
    const cached = [{ directory: "/repo" }, { directory: "/repo/feature", strategy: "git" }]
    const updated = updateProjectInfo(withWorktreeInventory(project, cached), { ...metadata, name: "After" })
    expect(withWorktreeInventory(updated, cached)).toMatchObject({ name: "After", sandboxes: ["/repo/feature"] })
  })
})
