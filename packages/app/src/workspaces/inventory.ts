import type { QueryClient } from "@tanstack/solid-query"
import type { WorktreeDirectory } from "@opencode/client/promise"
import type { ServerApi } from "@/runtime/server/api"
import type { ServerScope } from "@/runtime/server/scope"
import type { Project } from "@/runtime/server/types"
import { sameDirectory } from "./paths"

export function worktreeInventoryKey(scope: ServerScope, projectID: string) {
  return [scope, "worktree", projectID] as const
}

// Project metadata arrives without worktrees; a loaded inventory supplies the workspace list.
export function withWorktreeInventory(project: Project, worktrees: readonly WorktreeDirectory[] | undefined): Project {
  if (!worktrees) return project
  return {
    ...project,
    worktrees: [...worktrees],
    sandboxes: worktrees
      .map((item) => item.directory)
      .filter((directory) => !sameDirectory(project.worktree, directory)),
  }
}

// Reads use saved inventory; explicit demand also discovers external worktree changes.
export function createWorktreeInventory(input: {
  scope: ServerScope
  queryClient: QueryClient
  api: () => Pick<ServerApi["worktree"], "list" | "refresh">
  updated: (projectID: string, worktrees: WorktreeDirectory[]) => void
}) {
  const options = (projectID: string) => ({
    queryKey: worktreeInventoryKey(input.scope, projectID),
    queryFn: () =>
      input
        .api()
        .list({ projectID })
        .then((items) => {
          input.updated(projectID, items)
          return items
        }),
    // `worktree.updated` and reconnect invalidation drive refreshes; time alone does not re-list.
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  })
  return {
    cached: (projectID: string) =>
      input.queryClient.getQueryData<WorktreeDirectory[]>(worktreeInventoryKey(input.scope, projectID)),
    load: (projectID: string) => input.queryClient.fetchQuery(options(projectID)).catch(() => undefined),
    refresh: async (projectID: string) => {
      const items = await input.queryClient.fetchQuery(options(projectID)).catch(() => undefined)
      await input
        .api()
        .refresh({ projectID })
        .catch(() => undefined)
      return input.queryClient.fetchQuery({ ...options(projectID), staleTime: 0 }).catch(() => items)
    },
    // Only inventories some view already demanded are refreshed.
    reload: (projectID: string) => {
      if (!input.queryClient.getQueryState(worktreeInventoryKey(input.scope, projectID))) return Promise.resolve()
      return input.queryClient.fetchQuery({ ...options(projectID), staleTime: 0 }).catch(() => undefined)
    },
  }
}
