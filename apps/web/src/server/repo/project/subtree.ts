/**
 * Sub-project (WBS) tree helpers: descendant-set computation + subtree
 * rollup aggregation, pure and computed in TS at read time (never
 * denormalized). See packages/schemas/src/project.ts's `projectRollup` doc
 * comment for the own-vs-subtree distinction.
 *
 * The load pattern every caller (crud.ts's reader, lookup.ts's list, the two
 * dashboard reads, attention.ts) follows: fetch ALL live projects' `{id,
 * name, parentProjectId, costEstimate}` via `allProjectParentRows` — cheap,
 * single query, single-user scale — build the parent→children map once,
 * compute the page's descendant id set in TS, then fetch OWN rollups (the one
 * relatively expensive aggregate) only for the page ids + their descendants
 * via the shared batched project aggregates. Never one query per project.
 *
 * That whole sequence is {@link loadProjectSubtreeRollups} — call it rather
 * than re-assembling the four steps by hand (it was copy-pasted across five
 * files, and `projectDashboardSummary` ran it twice per request because
 * `computeAttentionItems` re-derived the same thing independently).
 */
import type { ProjectId } from "@cubby/schemas/identifiers";
import type { ProjectOut } from "@cubby/schemas/project";
import {
  MAX_PROJECT_TREE_DEPTH,
  type ProjectDateWindow,
  type ProjectStatus,
} from "@cubby/schemas/project";
import { format } from "date-fns";
import { asc } from "drizzle-orm";
import { uniq } from "es-toolkit";

import type { Database } from "~/server/db";
import { project } from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";

import {
  projectContentDates,
  projectRollupsAndContentDates,
} from "./analytics";
import {
  EMPTY_PROJECT_CONTENT_DATES,
  EMPTY_PROJECT_OWN_ROLLUP,
  maxPlainDate,
  minPlainDate,
  type ProjectContentDates,
  type ProjectOwnRollup,
  type ProjectSubtreeRollup,
} from "./helpers";

export type ProjectParentRow = {
  id: ProjectId;
  /** Public id — whole-tree consumers build links (attention items) from it. */
  shortcode: string;
  name: string;
  parentProjectId: ProjectId | null;
  costEstimate: number | null;
  /** Manual overrides on the derived window — see `aggregateSubtreeDates`. */
  startDate: string | null;
  endDate: string | null;
  /**
   * Carried so whole-tree consumers can tell finished work from live work
   * without a second query — `computeAttentionItems`' `missing_budget` rule
   * needs it (asking for a budget estimate on a `done` project is meaningless).
   */
  status: ProjectStatus;
  /** Completion-year fallback when the folded effective end is null. */
  updatedAt: Date;
  locations: string[];
  locationsMode: "inherit" | "explicit";
  defaultTrade: ProjectOut["defaultTrade"];
};

/**
 * All live projects' `{id, name, parentProjectId}` — the single query every
 * subtree/ancestor computation in this module is built on top of.
 */
async function allProjectParentRows(db: Database): Promise<ProjectParentRow[]> {
  return getDb(db)
    .select({
      id: project.id,
      shortcode: project.shortcode,
      name: project.name,
      parentProjectId: project.parentProjectId,
      costEstimate: project.costEstimate,
      startDate: project.startDate,
      endDate: project.endDate,
      status: project.status,
      updatedAt: project.updatedAt,
      locations: project.locations,
      locationsMode: project.locationsMode,
      defaultTrade: project.defaultTrade,
    })
    .from(project)
    .where(notDeleted(project))
    .orderBy(asc(project.name));
}

/** parentId -> direct child ids, built from a set of `{id, parentProjectId}` rows. */
function buildChildrenMap(
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
 * page's projects + their descendants) — ids outside that set fall back to a
 * zero rollup, which is harmless since callers only
 * read the map entries for ids whose full descendant set was included in the
 * `ownRollups` fetch.
 */
function aggregateSubtreeRollups(
  projects: ReadonlyArray<
    Pick<ProjectParentRow, "id" | "parentProjectId" | "costEstimate">
  >,
  ownRollups: Map<ProjectId, ProjectOwnRollup>,
): Map<ProjectId, ProjectSubtreeRollup> {
  const childrenByParent = buildChildrenMap(projects);
  const estimateById = new Map(projects.map((p) => [p.id, p.costEstimate]));
  const memo = new Map<ProjectId, ProjectSubtreeRollup>();

  function computeFor(id: ProjectId, depth: number): ProjectSubtreeRollup {
    const cached = memo.get(id);
    if (cached) return cached;

    const own = ownRollups.get(id) ?? EMPTY_PROJECT_OWN_ROLLUP;
    let spent = own.spent;
    let actualSpent = own.actualSpent;
    let committedSpent = own.committedSpent;
    let contributions = own.contributions;
    let expenseCount = own.expenseCount;
    let taskCount = own.taskCount;
    let doneTaskCount = own.doneTaskCount;
    let projectCount = 0;
    // costEstimate is nullable end-to-end: an unestimated subtree stays null
    // rather than collapsing to a misleading $0.
    const ownEstimate = estimateById.get(id) ?? null;
    let costEstimate = ownEstimate ?? 0;
    let hasEstimate = ownEstimate !== null;

    if (depth < MAX_PROJECT_TREE_DEPTH) {
      for (const childId of childrenByParent.get(id) ?? []) {
        const child = computeFor(childId, depth + 1);
        spent += child.spent;
        actualSpent += child.actualSpent;
        committedSpent += child.committedSpent;
        contributions += child.contributions;
        expenseCount += child.expenseCount;
        taskCount += child.taskCount;
        doneTaskCount += child.doneTaskCount;
        projectCount += 1 + child.projectCount;
        if (child.costEstimate !== null) {
          costEstimate += child.costEstimate;
          hasEstimate = true;
        }
      }
    }

    const result: ProjectSubtreeRollup = {
      spent,
      actualSpent,
      committedSpent,
      contributions,
      expenseCount,
      taskCount,
      doneTaskCount,
      projectCount,
      costEstimate: hasEstimate ? costEstimate : null,
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

/**
 * Post-order date fold, the mirror of {@link aggregateSubtreeRollups}:
 *
 *   derived(node)   = content(node) ∪ effective(child) for every live child
 *   effective(node) = the node's explicit `startDate`/`endDate` override when
 *                     set, else derived(node) — resolved per side, so an
 *                     explicit start can pair with a derived end
 *
 * Children contribute their **effective** window, not their content: an
 * override on a sub-project is a statement about that sub-project's real span,
 * so it must propagate up rather than being bypassed by the raw task dates
 * underneath it.
 *
 * A node's own override deliberately does NOT widen to cover its descendants —
 * a too-narrow override stays visible as-is and is reported by the
 * `date_window_drift` attention rule instead. Silently widening it would erase
 * the only signal that the stored value is stale.
 *
 * Memoized and depth-capped exactly like the rollup fold, so a corrupt cyclic
 * parent chain terminates at `MAX_PROJECT_TREE_DEPTH` rather than recursing
 * forever. `ownDates` need only cover the ids the caller fetched; anything
 * outside it folds as "no content", which is harmless for the same reason it is
 * there — callers only read ids whose full descendant set was loaded.
 */
export function aggregateSubtreeDates(
  projects: ReadonlyArray<
    Pick<ProjectParentRow, "id" | "parentProjectId" | "startDate" | "endDate">
  >,
  ownDates: Map<ProjectId, ProjectContentDates>,
): Map<ProjectId, ProjectDateWindow> {
  const childrenByParent = buildChildrenMap(projects);
  const rowById = new Map(projects.map((p) => [p.id, p]));
  const memo = new Map<ProjectId, ProjectDateWindow>();

  function computeFor(id: ProjectId, depth: number): ProjectDateWindow {
    const cached = memo.get(id);
    if (cached) return cached;

    const own = ownDates.get(id) ?? EMPTY_PROJECT_CONTENT_DATES;
    let derivedStart = own.contentStart;
    let derivedEnd = own.contentEnd;

    if (depth < MAX_PROJECT_TREE_DEPTH) {
      for (const childId of childrenByParent.get(id) ?? []) {
        const child = computeFor(childId, depth + 1);
        derivedStart = minPlainDate(derivedStart, child.effectiveStart);
        derivedEnd = maxPlainDate(derivedEnd, child.effectiveEnd);
      }
    }

    const row = rowById.get(id);
    const explicitStart = row?.startDate ?? null;
    const explicitEnd = row?.endDate ?? null;
    const effectiveStart = explicitStart ?? derivedStart;
    const effectiveEnd = explicitEnd ?? derivedEnd;

    const result: ProjectDateWindow = {
      derivedStart,
      derivedEnd,
      effectiveStart,
      effectiveEnd,
      startSource:
        explicitStart != null
          ? "explicit"
          : derivedStart != null
            ? "derived"
            : "none",
      endSource:
        explicitEnd != null
          ? "explicit"
          : derivedEnd != null
            ? "derived"
            : "none",
    };
    memo.set(id, result);
    return result;
  }

  const out = new Map<ProjectId, ProjectDateWindow>();
  for (const p of projects) {
    out.set(p.id, computeFor(p.id, 0));
  }
  return out;
}

/** The whole live project tree in the three shapes callers read it in. */
export type ProjectTree = {
  allRows: ProjectParentRow[];
  childrenByParent: Map<ProjectId, ProjectId[]>;
  nameById: Map<ProjectId, string>;
  shortcodeById: Map<ProjectId, string>;
};

/**
 * {@link ProjectTree} plus the OWN and SUBTREE rollups for the loaded ids, and
 * the folded date window ({@link aggregateSubtreeDates}) for every project in
 * the tree.
 */
export type ProjectSubtreeRollups = ProjectTree & {
  ownRollups: Map<ProjectId, ProjectOwnRollup>;
  subtreeRollups: Map<ProjectId, ProjectSubtreeRollup>;
  dateWindows: Map<ProjectId, ProjectDateWindow>;
};

/** The existing History definition, centralized for every server read. */
export function projectCompletionYear(
  row: Pick<ProjectParentRow, "updatedAt">,
  window: ProjectDateWindow,
): string {
  return (window.effectiveEnd ?? format(row.updatedAt, "yyyy-MM-dd")).slice(
    0,
    4,
  );
}

/**
 * Step 1 of the pipeline on its own — one query, no rollups. Only for the
 * caller that needs the tree *before* it knows its ids: `projectList` resolves
 * `includeSubProjects` into its WHERE clause, so it can't hand the ids to
 * {@link loadProjectSubtreeRollups} until the tree is already in hand. Pass
 * the result back in as that function's `tree` argument — never re-fetch.
 */
export async function loadProjectTree(db: Database): Promise<ProjectTree> {
  const allRows = await allProjectParentRows(db);
  return {
    allRows,
    childrenByParent: buildChildrenMap(allRows),
    nameById: new Map(allRows.map((r) => [r.id, r.name])),
    shortcodeById: new Map(allRows.map((r) => [r.id, r.shortcode])),
  };
}

/** Lightweight whole-tree date fold without loading spend/task rollups. */
export async function loadProjectDateWindows(
  db: Database,
  tree?: ProjectTree,
): Promise<{
  tree: ProjectTree;
  dateWindows: Map<ProjectId, ProjectDateWindow>;
}> {
  const loaded = tree ?? (await loadProjectTree(db));
  const contentDates = await projectContentDates(db);
  return {
    tree: loaded,
    dateWindows: aggregateSubtreeDates(loaded.allRows, contentDates),
  };
}

/**
 * The whole load pattern in one call: tree → descendant ids → batched OWN
 * rollups + content dates → subtree aggregation. Four queries total (one for
 * the tree, one shared expense allocation aggregate, and two task aggregates),
 * regardless of how many projects are involved.
 *
 * `ids` scopes the (relatively expensive) OWN-rollup fetch to those projects
 * plus every live descendant — the minimum set whose subtree totals are then
 * exact. **Omit it** for the whole-tree variant (`computeAttentionItems`, and
 * `projectDashboardSummary` which feeds it): every id is already covered, so
 * the descendant walk is skipped entirely.
 *
 * Reading a *superset* never changes a caller's numbers — `aggregateSubtree
 * Rollups` only consults a node's own descendants — which is why the dashboard
 * can share one whole-tree load with attention instead of running the pipeline
 * twice.
 *
 * `tree` accepts an already-loaded {@link loadProjectTree} result.
 */
export async function loadProjectSubtreeRollups(
  db: Database,
  ids?: ProjectId[],
  tree?: ProjectTree,
): Promise<ProjectSubtreeRollups> {
  const loaded = tree ?? (await loadProjectTree(db));
  const rollupIds =
    ids === undefined
      ? loaded.allRows.map((r) => r.id)
      : uniq([
          ...ids,
          ...ids.flatMap((id) =>
            collectDescendantIds(loaded.childrenByParent, id),
          ),
        ]);

  const { ownRollups, contentDates } = await projectRollupsAndContentDates(
    db,
    rollupIds,
  );
  return {
    ...loaded,
    ownRollups,
    subtreeRollups: aggregateSubtreeRollups(loaded.allRows, ownRollups),
    dateWindows: aggregateSubtreeDates(loaded.allRows, contentDates),
  };
}
