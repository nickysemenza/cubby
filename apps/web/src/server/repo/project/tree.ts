/**
 * The WBS renderer's page reader: same filters as {@link projectList}, but the
 * unit of pagination is a **root of the filtered forest** rather than a row.
 *
 * Why this exists at all: nesting rows in the browser is presentation, but
 * *choosing* which rows to nest is membership, and membership belongs on the
 * server (see AGENTS.md — "full-page list membership, sorting, totals, and
 * pagination belong on the server"). A tree built over an ordinary paginated
 * page would have a shape decided by where the page boundary happened to fall:
 * a parent on page 1 and its children on page 3, roots that are only roots
 * because their parent didn't fit. So the page is chosen here — N roots plus
 * their matching descendants — and `buildProjectTree` (app/projects) does
 * nothing but nest what this returned.
 *
 * "Root" means *of the filtered forest*, not `parentProjectId IS NULL`: a
 * project that matches while its parent does not is a root of its own. That is
 * the server-side statement of the same orphan-promotion rule the client
 * builder applies, and it's what keeps a filter from silently hiding a matching
 * sub-project underneath an excluded parent.
 *
 * Cost: one extra id-only scan of `Project` on top of what the flat list
 * already does (which itself loads the whole tree every call — see subtree.ts).
 * At single-user scale — ~75 projects, 15 of them children — that is noise; if
 * this table ever grew orders of magnitude, the root selection is the part that
 * would need to become a recursive CTE.
 */

import type { ProjectId } from "@cubby/schemas/identifiers";
import {
  buildTakeSkip,
  type PaginationParams,
  type SortParams,
} from "@cubby/schemas/pagination";
import type {
  ProjectFilters,
  ProjectListItemOut,
} from "@cubby/schemas/project";
import { and, inArray } from "drizzle-orm";

import type { Database } from "~/server/db";
import { project } from "~/server/db/schema";
import { loadDataQualities } from "~/server/repo/data-quality";
import { getDb } from "~/server/repo/database-helpers";
import { withDisplayImages } from "~/server/repo/entity-display-image";

import { projectDependencyIds } from "./analytics";
import { hydrateProjectRow } from "./helpers";
import { buildProjectListQuery, projectListSums } from "./lookup";
import { collectDescendantIds, loadProjectSubtreeRollups } from "./subtree";

/**
 * One page of the project WBS tree: `count` is the number of matching ROOTS
 * (the paging unit, which is what the infinite-scroll page arithmetic counts
 * against), and `data` is this page's roots plus every matching descendant
 * beneath them, in the query's global sort order — so the client's per-parent
 * input-order nesting reproduces that ordering at every level of the tree.
 *
 * `sums`, by contrast, is deliberately NOT scoped to roots — see
 * `projectListSums`'s doc comment. It's the same full-filtered-set total
 * `projectList` returns, computed off the same `whereClause`, because the
 * `costEstimate` footer means "every matching project's own estimate,
 * summed" regardless of which renderer is drawing the rows.
 */
export const projectTreePage = async (
  db: Database,
  filters: ProjectFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
): Promise<{
  data: ProjectListItemOut[];
  count: number;
  sums: { costEstimate: number };
}> => {
  const { tree, whereClause, orderByArray } = await buildProjectListQuery(
    db,
    filters,
    sorts,
  );
  // The full matching set, ordered but unpaginated — ids only. Run through
  // RQB (not `select().from(project)`) because the effective-start ORDER BY is
  // `sql.raw` with the `"project"` alias spelled out by hand, and only the
  // relational builder aliases the root table that way. See the comment on
  // `effectiveStartSortSql` in lookup.ts.
  //
  // The footer sum is independent of root selection (see `projectListSums`'s
  // doc comment), so it runs alongside this scan rather than after it.
  const [matchingRows, sums] = await Promise.all([
    getDb(db).query.project.findMany({
      columns: { id: true, parentProjectId: true },
      where: whereClause,
      orderBy: orderByArray,
    }),
    projectListSums(db, whereClause),
  ]);
  const matching = new Set(matchingRows.map((row) => row.id));

  // The forest the CLIENT will draw: an edge exists only between a matching
  // project and its matching DIRECT parent. So a root is a match whose direct
  // parent doesn't match — including a grandchild whose parent was filtered
  // out but whose grandparent survives. That's deliberately not "has no
  // matching ancestor": the client's `buildProjectTree` promotes on the direct
  // parent alone, and if the two rules disagreed the server would report a
  // root count for a shape the browser doesn't render.
  const matchingChildren = new Map<ProjectId, ProjectId[]>();
  const roots: ProjectId[] = [];
  for (const row of matchingRows) {
    const parentId = row.parentProjectId;
    if (parentId == null || !matching.has(parentId)) {
      roots.push(row.id);
      continue;
    }
    const siblings = matchingChildren.get(parentId);
    if (siblings) {
      siblings.push(row.id);
    } else {
      matchingChildren.set(parentId, [row.id]);
    }
  }

  const { take, skip } = buildTakeSkip(pagination);
  const pageRoots = roots.slice(skip, skip + take);
  if (pageRoots.length === 0) return { data: [], count: roots.length, sums };

  // Every id reachable from a page root through matching-parent edges — by
  // construction already inside the matching set, and depth-capped /
  // cycle-guarded by `collectDescendantIds`.
  const keep = new Set<ProjectId>();
  for (const rootId of pageRoots) {
    keep.add(rootId);
    for (const descendantId of collectDescendantIds(matchingChildren, rootId)) {
      keep.add(descendantId);
    }
  }

  // `whereClause` is re-applied on top of the id set: the closure is only ever
  // allowed to NARROW the matching set, never widen it.
  const rows = await getDb(db).query.project.findMany({
    where: and(inArray(project.id, [...keep]), whereClause),
    orderBy: orderByArray,
  });

  const ids = rows.map((row) => row.id);
  const [projectContext, deps, dataQualities] = await Promise.all([
    loadProjectSubtreeRollups(db, ids, tree),
    projectDependencyIds(db, ids),
    loadDataQualities(db, "project", ids),
  ]);

  return {
    data: await withDisplayImages(db, "project", rows, (row) =>
      // SAFETY: `row` came from `rows`, which `dataQualities` was loaded for.
      hydrateProjectRow(row, projectContext, deps, dataQualities.get(row.id)!),
    ),
    count: roots.length,
    sums,
  };
};
