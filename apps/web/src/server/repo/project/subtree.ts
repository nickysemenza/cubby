/**
 * Sub-project (WBS) tree helpers: descendant-set computation + subtree
 * rollup aggregation, pure and computed in TS at read time (never
 * denormalized). See packages/schemas/src/project.ts's `projectRollup` doc
 * comment for the own-vs-subtree distinction.
 *
 * The load pattern every caller (crud.ts's reader, lookup.ts's list, the
 * dashboard router) follows: fetch ALL live projects' `{id, name,
 * parentProjectId}` via `allProjectParentRows` — cheap, single query,
 * single-user scale — build the parent→children map once, compute the
 * page's descendant id set in TS, then fetch OWN rollups (the one relatively
 * expensive aggregate) only for the page ids + their descendants via the
 * existing batched `projectRollups`. Never one query per project.
 */
import type { ProjectId } from "@cubby/schemas/identifiers";
import { asc } from "drizzle-orm";
import type { Database } from "~/server/db";
import { project } from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import {
  EMPTY_PROJECT_OWN_ROLLUP,
  type ProjectOwnRollup,
  type ProjectSubtreeRollup,
} from "./helpers";

export type ProjectParentRow = {
  id: ProjectId;
  name: string;
  parentProjectId: ProjectId | null;
};

/** Depth cap for tree walks (children-map traversal, ancestor walks) —
 * defensive backstop against a corrupt/cyclic tree; a well-formed one (the
 * create/update cycle guard rejects cycles) never gets remotely close. */
export const MAX_PROJECT_TREE_DEPTH = 100;

/**
 * All live projects' `{id, name, parentProjectId}` — the single query every
 * subtree/ancestor computation in this module is built on top of.
 */
export async function allProjectParentRows(
  db: Database,
): Promise<ProjectParentRow[]> {
  return getDb(db)
    .select({
      id: project.id,
      name: project.name,
      parentProjectId: project.parentProjectId,
    })
    .from(project)
    .where(notDeleted(project))
    .orderBy(asc(project.name));
}

/** parentId -> direct child ids, built from a set of `{id, parentProjectId}` rows. */
export function buildChildrenMap(
  rows: ReadonlyArray<Pick<ProjectParentRow, "id" | "parentProjectId">>,
): Map<ProjectId, ProjectId[]> {
  const map = new Map<ProjectId, ProjectId[]>();
  for (const row of rows) {
    if (!row.parentProjectId) continue;
    const arr = map.get(row.parentProjectId);
    if (arr) {
      arr.push(row.id);
    } else {
      map.set(row.parentProjectId, [row.id]);
    }
  }
  return map;
}

/**
 * Every descendant id under `rootId` (excludes `rootId` itself) — BFS over
 * the children map, depth-capped and cycle-guarded via a visited set.
 */
export function collectDescendantIds(
  childrenByParent: Map<ProjectId, ProjectId[]>,
  rootId: ProjectId,
): ProjectId[] {
  const out: ProjectId[] = [];
  const visited = new Set<ProjectId>([rootId]);
  const queue: Array<{ id: ProjectId; depth: number }> = [
    { id: rootId, depth: 0 },
  ];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    if (current.depth >= MAX_PROJECT_TREE_DEPTH) continue;
    for (const childId of childrenByParent.get(current.id) ?? []) {
      if (visited.has(childId)) continue;
      visited.add(childId);
      out.push(childId);
      queue.push({ id: childId, depth: current.depth + 1 });
    }
  }
  return out;
}

/**
 * Post-order subtree accumulation over a set of `{id, parentProjectId}`
 * rows: `subtree(node) = own(node) + Σ subtree(child)`, `projectCount(node)
 * = Σ (1 + projectCount(child))` — so a leaf's subtree always equals its own
 * rollup with `projectCount` 0.
 *
 * Pure and memoized (each id's subtree computed once regardless of how many
 * ancestors read it), depth-capped like `collectDescendantIds`. `ownRollups`
 * only needs to cover the ids the caller actually fetched (typically a
 * page's projects + their descendants, via `projectRollups`) — ids outside
 * that set fall back to a zero rollup, which is harmless since callers only
 * read the map entries for ids whose full descendant set was included in the
 * `ownRollups` fetch.
 */
export function aggregateSubtreeRollups(
  projects: ReadonlyArray<Pick<ProjectParentRow, "id" | "parentProjectId">>,
  ownRollups: Map<ProjectId, ProjectOwnRollup>,
): Map<ProjectId, ProjectSubtreeRollup> {
  const childrenByParent = buildChildrenMap(projects);
  const memo = new Map<ProjectId, ProjectSubtreeRollup>();

  function computeFor(id: ProjectId, depth: number): ProjectSubtreeRollup {
    const cached = memo.get(id);
    if (cached) return cached;

    const own = ownRollups.get(id) ?? EMPTY_PROJECT_OWN_ROLLUP;
    let spent = own.spent;
    let purchaseCount = own.purchaseCount;
    let taskCount = own.taskCount;
    let doneTaskCount = own.doneTaskCount;
    let projectCount = 0;

    if (depth < MAX_PROJECT_TREE_DEPTH) {
      for (const childId of childrenByParent.get(id) ?? []) {
        const child = computeFor(childId, depth + 1);
        spent += child.spent;
        purchaseCount += child.purchaseCount;
        taskCount += child.taskCount;
        doneTaskCount += child.doneTaskCount;
        projectCount += 1 + child.projectCount;
      }
    }

    const result: ProjectSubtreeRollup = {
      spent,
      purchaseCount,
      taskCount,
      doneTaskCount,
      projectCount,
    };
    memo.set(id, result);
    return result;
  }

  const out = new Map<ProjectId, ProjectSubtreeRollup>();
  for (const p of projects) {
    out.set(p.id, computeFor(p.id, 0));
  }
  return out;
}
