import type { ActorContext } from "@cubby/schemas/context";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import type { OperationDisposition } from "@cubby/schemas/entity-integrity";
import type { ProjectId, ProjectShortcode } from "@cubby/schemas/identifiers";
import {
  MAX_PROJECT_TREE_DEPTH,
  type ProjectCreateInput,
  type ProjectOut,
  type ProjectUpdateInput,
} from "@cubby/schemas/project";
import { and, eq, inArray, sql } from "drizzle-orm";

import type { Database, DrizzleClient, DrizzleTransaction } from "~/server/db";
import type { IncomingEdgePolicy } from "~/server/db/entity-incoming-edges";
import { expense, project, task } from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import {
  type AuditChangeMap,
  computeChanges,
  diffUnorderedIdSet,
  logAuditEntry,
} from "~/server/repo/audit-log";
import { loadDataQualities } from "~/server/repo/data-quality/hydrate";
import {
  assertNoDependents,
  buildPartialUpdateValues,
  getDb,
  notDeleted,
  replaceDependencyEdges,
  updateLiveAndReturn,
  withTransaction,
} from "~/server/repo/database-helpers";
import { validateLiveEffectiveTrades } from "~/server/repo/inheritance-validation";
/**
 * Project CRUD operations.
 *
 * The read path goes through `createEntityReader`, but the write path is
 * hand-rolled (like meal/location): `update` manages the `blockedByIds`
 * replacement set (delete-then-insert `projectDependency` rows) inside the
 * same transaction as the column update, and `delete` guards against
 * orphaning live tasks/expenses before hard-deleting the dependency edges.
 */
import { policyDelete } from "~/server/repo/removal/dispositions";
import { createEntityReader } from "~/server/repo/repository";
import {
  resolveAllOrThrow,
  resolveOrThrow,
} from "~/server/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { effectiveExpenseProjectSql } from "../expense-inheritance";
import {
  effectiveTaskProjectSql,
  effectiveProjectLocationsSql,
  effectiveProjectTradeSql,
} from "../task-project-inheritance";
import { projectDependencyIds } from "./analytics";
import {
  setProjectExternalUrls,
  withProjectExternalUrls,
} from "./external-links";
import { hydrateProjectRow } from "./helpers";
import { loadProjectSubtreeRollups } from "./subtree";

export const PROJECT_DELETE_EDGE_POLICY = {
  "Purchase.defaultProjectId": {
    code: "block-live-purchase-default",
    effect: "block",
    description:
      "A project selected as a live purchase default cannot be deleted until the purchase is reassigned.",
  },
  "Project.parentProjectId": {
    code: "block-live-child",
    effect: "block",
    description:
      "A project with live sub-projects can't be deleted — delete or reparent them first.",
  },
  "EntityLink[projectDependency].from": {
    code: "soft-delete-dependency",
    effect: "soft-delete",
    description:
      "Blocks/blocked-by dependency links naming the project are soft-deleted with it.",
  },
  "EntityLink[projectDependency].to": {
    code: "soft-delete-dependency",
    effect: "soft-delete",
    description:
      "Blocks/blocked-by dependency links naming the project are soft-deleted with it.",
  },
  "Task.projectId": {
    code: "block-live-task",
    effect: "block",
    description:
      "A project with live tasks can't be deleted — delete or reassign them first.",
  },
  "Expense.projectId": {
    code: "block-live-expense",
    effect: "block",
    description:
      "A project with live expenses can't be deleted — delete or reassign them first.",
  },
  "EntityAttachment.entityId": {
    code: "soft-delete-association",
    effect: "soft-delete",
    description:
      "Image associations are soft-deleted with the project, and each file is\n      deleted too unless something else still references it.",
  },
  "EntityLink[projectTool].from": {
    code: "soft-delete-association",
    effect: "soft-delete",
    description:
      "Tool-use associations are soft-deleted with the project; the tool Products and their other project history remain.",
  },
  "EntityExternalId.entityId": {
    code: "soft-delete-metadata",
    effect: "soft-delete",
    description:
      "Outside identifiers (a Notion page, a Drive folder) are soft-deleted with the record, releasing them to be recorded again.",
  },
} as const satisfies IncomingEdgePolicy<"project", OperationDisposition>;

/** `projectUpdateData` has no standalone type export — derive it from the input. */
type ProjectUpdateData = ProjectUpdateInput["data"];

const fetchProjectById = (db: Database, id: ProjectId) =>
  getDb(db).query.project.findFirst({
    where: and(eq(project.id, id), notDeleted(project)),
  });

const projectReader = createEntityReader({
  entity: "project",
  fetchById: fetchProjectById,
  fromDB: async (db, row) => {
    // Whole-tree parent/child map + this project's subtree rollup — see
    // subtree.ts's doc comment for why the tree is loaded in full rather than
    // walked with per-row queries.
    const [projectContext, deps, dataQualities, [withUrls]] = await Promise.all(
      [
        loadProjectSubtreeRollups(db, [row.id]),
        projectDependencyIds(db, [row.id]),
        loadDataQualities(db, "project", [row.id]),
        withProjectExternalUrls(db, [row]),
      ],
    );

    // SAFETY: `row` was just fetched live by id, so its quality was evaluated.
    return hydrateProjectRow(
      withUrls!,
      projectContext,
      deps,
      dataQualities.get(row.id)!,
    );
  },
});

export const getProjectByID = (
  db: Database,
  id: ProjectId,
): Promise<ProjectOut> => projectReader.getByID(db, id);

export const getProjectByShortcode = (db: Database, shortcode: string) =>
  projectReader.getByShortcode(db, shortcode);

/**
 * Walk `newParentId`'s ancestor chain (up to `MAX_PROJECT_TREE_DEPTH` hops,
 * defensively) looking for `projectId` — true if setting the parent would
 * make `projectId` its own ancestor. Mirrors
 * repo/location/tree.ts's `wouldCreateParentCycle`.
 */
async function wouldCreateProjectCycle(
  tx: DrizzleTransaction,
  projectId: ProjectId,
  newParentId: ProjectId,
): Promise<boolean> {
  if (projectId === newParentId) return true;

  let currentId: ProjectId | null = newParentId;
  let hops = 0;
  while (currentId && hops < MAX_PROJECT_TREE_DEPTH) {
    if (currentId === projectId) return true;
    const row: { parentProjectId: ProjectId | null } | undefined =
      await tx.query.project.findFirst({
        where: eq(project.id, currentId),
        columns: { parentProjectId: true },
      });
    currentId = row?.parentProjectId ?? null;
    hops++;
  }
  return false;
}

export const createProject = async (
  db: Database,
  data: ProjectCreateInput,
  actor: ActorContext,
): Promise<{ output: ProjectOut; entityId: ProjectId }> => {
  const id = await withTransaction(db, async (tx) => {
    // Resolving THROUGH a LIVE-only lookup is the "exists and is live" check
    // itself — an FK proves the parent row exists, not that it's live.
    let parentProjectId: ProjectId | null = null;
    if (data.parentProjectId) {
      parentProjectId = await resolveOrThrow(
        tx,
        "project",
        data.parentProjectId,
      );
    }

    const created = await insertWithShortcode(tx, "project", {
      name: data.name,
      status: data.status,
      kind: data.kind,
      locations: data.locations,
      locationsMode:
        data.locationsMode ?? (data.locations.length ? "explicit" : "inherit"),
      defaultTrade: data.defaultTrade,
      costEstimate: data.costEstimate,
      parentProjectId,
      startDate: data.startDate,
      endDate: data.endDate,
      emoji: data.emoji,
      notes: data.notes,
    });
    await setProjectExternalUrls(tx, created.id, {
      googleDriveFolderUrl: data.googleDriveFolderUrl,
      notionPageUrl: data.notionPageUrl,
    });
    await validateLiveEffectiveTrades(tx);
    await logAuditEntry(tx, actor, {
      entityKind: "project",
      entityId: created.id,
      action: "create",
    });
    return created.id;
  });
  return { output: await getProjectByID(db, id), entityId: id };
};

async function projectSettingsAfterParentChange(
  tx: DrizzleTransaction,
  id: ProjectId,
  before: NonNullable<Awaited<ReturnType<typeof fetchProjectById>>>,
  data: ProjectUpdateData,
  parentProjectId: ProjectId | null | undefined,
) {
  const detached = parentProjectId === null && before.parentProjectId !== null;
  const inherited = detached
    ? (
        await tx.execute<{
          locations: string[];
          trade: ProjectOut["defaultTrade"];
        }>(sql`
    SELECT ${effectiveProjectLocationsSql(sql`${id}::uuid`)} AS locations,
      ${effectiveProjectTradeSql(sql`${id}::uuid`)} AS trade
  `)
      ).rows[0]
    : undefined;
  const preserveLocations =
    detached &&
    before.locationsMode === "inherit" &&
    data.locations === undefined &&
    data.locationsMode === undefined;
  return {
    locations:
      data.locationsMode === "inherit"
        ? []
        : preserveLocations
          ? (inherited?.locations ?? [])
          : data.locations,
    locationsMode: preserveLocations
      ? ("explicit" as const)
      : (data.locationsMode ??
        (data.locations === undefined ? undefined : ("explicit" as const))),
    defaultTrade:
      detached &&
      before.defaultTrade === null &&
      data.defaultTrade === undefined
        ? (inherited?.trade ?? null)
        : data.defaultTrade,
  };
}

export const updateProject = async (
  db: Database,
  shortcode: ProjectShortcode,
  data: ProjectUpdateData,
  actor: ActorContext,
): Promise<{ output: ProjectOut; entityId: ProjectId }> => {
  const id = await resolveOrThrow(db, "project", shortcode);

  const before = await fetchProjectById(db, id);
  if (!before) {
    throw createAppError("PROJECT_NOT_FOUND", `Project ${id} not found`);
  }
  const beforeBlockedBy =
    data.blockedByIds !== undefined
      ? ((await projectDependencyIds(db, [id])).blockedBy.get(id) ?? [])
      : undefined;

  await withTransaction(db, async (tx) => {
    let parentProjectId: ProjectId | null | undefined;
    if (data.parentProjectId !== undefined && data.parentProjectId !== null) {
      parentProjectId = await resolveOrThrow(
        tx,
        "project",
        data.parentProjectId,
      );
      if (parentProjectId === id) {
        throw createAppError(
          "SELF_DEPENDENCY",
          "A project cannot be its own parent.",
        );
      }
      if (await wouldCreateProjectCycle(tx, id, parentProjectId)) {
        throw createAppError(
          "PROJECT_CYCLE",
          "Cannot set parent: would create a circular reference.",
        );
      }
    } else if (data.parentProjectId === null) {
      parentProjectId = null;
    }

    // Full-replacement set: resolve every requested shortcode to a live uuid
    // up front — `replaceDependencyEdges`'s own not-found check operates on
    // the FK column, so it can't be handed a shortcode.
    let resolvedBlockedByIds: ProjectId[] | undefined;
    if (data.blockedByIds !== undefined) {
      resolvedBlockedByIds = await resolveAllOrThrow(
        tx,
        "project",
        data.blockedByIds,
      );
    }

    const settings = await projectSettingsAfterParentChange(
      tx,
      id,
      before,
      data,
      parentProjectId,
    );
    const updateValues = buildPartialUpdateValues({
      name: data.name,
      status: data.status,
      kind: data.kind,
      ...settings,
      costEstimate: data.costEstimate,
      parentProjectId,
      startDate: data.startDate,
      endDate: data.endDate,
      emoji: data.emoji,
      notes: data.notes,
    });
    const [beforeWithUrls] = await withProjectExternalUrls(tx, [before]);
    const updatedRow = await updateLiveAndReturn(tx, project, updateValues, id);
    await setProjectExternalUrls(tx, id, {
      googleDriveFolderUrl: data.googleDriveFolderUrl,
      notionPageUrl: data.notionPageUrl,
    });
    const [updated] = await withProjectExternalUrls(tx, [updatedRow]);
    await validateLiveEffectiveTrades(tx);

    // Full-replacement set: clear this project's blocked-by edges and insert
    // the new ones, all inside the same transaction as the column update.
    if (resolvedBlockedByIds !== undefined) {
      await replaceDependencyEdges(
        tx,
        { entityTable: project, entity: "project" },
        id,
        resolvedBlockedByIds,
      );
    }

    const changes: AuditChangeMap = {
      ...computeChanges(beforeWithUrls!, updated!, [
        ...entityFieldModels.project.audit,
      ]),
    };
    if (resolvedBlockedByIds !== undefined) {
      const blockedByChange = diffUnorderedIdSet(
        beforeBlockedBy ?? [],
        resolvedBlockedByIds,
      );
      if (blockedByChange) {
        changes.blockedByIds = blockedByChange;
      }
    }
    if (Object.keys(changes).length > 0) {
      await logAuditEntry(tx, actor, {
        entityKind: "project",
        entityId: id,
        action: "update",
        changes,
      });
    }
  });

  return { output: await getProjectByID(db, id), entityId: id };
};

/** Either a checked-out transaction or a plain client — reads work the same on both. */
type ProjectQueryClient = DrizzleClient | DrizzleTransaction;

/**
 * Live tasks under `ids`. Used by the delete's PROJECT_HAS_TASKS guard.
 */
const fetchLiveProjectTasks = (dbc: ProjectQueryClient, ids: ProjectId[]) =>
  dbc
    .select({ projectId: effectiveTaskProjectSql() })
    .from(task)
    .where(and(inArray(effectiveTaskProjectSql(), ids), notDeleted(task)));

/**
 * Live expenses under `ids`. Used by `deleteProjects`' PROJECT_HAS_EXPENSES
 * guard.
 */
const fetchLiveProjectExpenses = (dbc: ProjectQueryClient, ids: ProjectId[]) =>
  dbc
    .select({ projectId: effectiveExpenseProjectSql() })
    .from(expense)
    .where(
      and(inArray(effectiveExpenseProjectSql(), ids), notDeleted(expense)),
    );

/**
 * Tasks and expenses block by their EFFECTIVE project — one inherited through
 * a purchase or parent still belongs to it — so those two block edges are
 * guarded here rather than by the FK column alone.
 */
const refuseEffectiveMembers =
  (
    fetch: (
      tx: DrizzleTransaction,
      ids: ProjectId[],
    ) => PromiseLike<{ projectId: ProjectId | null }[]>,
    reason: "PROJECT_HAS_TASKS" | "PROJECT_HAS_EXPENSES",
    noun: string,
  ) =>
  async (tx: DrizzleTransaction, ids: ProjectId[]) =>
    assertNoDependents({
      offendingParentIds: (await fetch(tx, ids)).map((row) => row.projectId),
      fetchNames: (failedIds) =>
        tx.query.project.findMany({
          where: inArray(project.id, failedIds),
          columns: { name: true },
        }),
      reason,
      message: (count, names) =>
        `Cannot delete ${count} project(s): ${names} still have ${noun}. Delete or reassign them first.`,
    });

/**
 * Returns the R2 keys of images the cascade reaped, for the caller to drop
 * after this commit — an object delete has no rollback.
 */
export const deleteProjects = policyDelete(
  "project",
  PROJECT_DELETE_EDGE_POLICY,
  {
    overrides: {
      "Task.projectId": refuseEffectiveMembers(
        fetchLiveProjectTasks,
        "PROJECT_HAS_TASKS",
        "tasks",
      ),
      "Expense.projectId": refuseEffectiveMembers(
        fetchLiveProjectExpenses,
        "PROJECT_HAS_EXPENSES",
        "expenses",
      ),
    },
  },
);
