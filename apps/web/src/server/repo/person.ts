import type { ActorContext } from "@cubby/schemas/context";
import type { OperationDisposition } from "@cubby/schemas/entity-integrity";
import type { PersonId, PersonShortcode } from "@cubby/schemas/identifiers";
import { unsafePersonShortcode } from "@cubby/schemas/identifiers";
import {
  buildTakeSkip,
  type PaginationParams,
  type SortParams,
} from "@cubby/schemas/pagination";
import type {
  PersonCreateInput,
  PersonFilters,
  PersonMergeSummaryOut,
  PersonOut,
  PersonUpdateData,
} from "@cubby/schemas/person";
import { personMergeSummaryOut, personOut } from "@cubby/schemas/person";
import {
  and,
  asc,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  not,
  or,
  sql,
} from "drizzle-orm";
import { uniq } from "es-toolkit";
import type { Database, DrizzleTransaction } from "~/server/db";
import type { IncomingEdgePolicy } from "~/server/db/entity-incoming-edges";
import {
  expenseAttribution,
  financialAccount,
  financialAccountPerson,
  fundingSource,
  fundingTransfer,
  person,
  user,
} from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import { computeChanges, logAuditEntry } from "~/server/repo/audit-log";
import {
  auditDateWhereConditions,
  buildPartialUpdateValues,
  countWhere,
  executeListQueryWithCount,
  getDb,
  lockAndValidateForDelete,
  notDeleted,
  unwrapDb,
  withTransaction,
} from "~/server/repo/database-helpers";
import { createEntityReader } from "~/server/repo/entity-crud-factory";
import { foldPersonFundingSourceForMerge } from "~/server/repo/household-contribution";
import { countByTarget, impact, present } from "~/server/repo/impact";
import { finalizeMerge, resolveMergeTargets } from "~/server/repo/merge/core";
import { removeEntity } from "~/server/repo/removal";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

export const PERSON_DELETE_EDGE_POLICY = {
  "FundingSource.personId": {
    code: "remove-person-funding-source",
    effect: "soft-delete",
    description:
      "Remove the private funding companion after confirming it has no remaining evidence references.",
  },
  "ExpenseAttribution.personId": {
    code: "block-beneficiary-attribution",
    effect: "block",
    description:
      "An attributed expense must be reassigned or merged before its person can be removed.",
  },
  "FinancialAccountPerson.personId": {
    code: "block-account-membership",
    effect: "block",
    description:
      "An account ownership or access record must be removed or reassigned first.",
  },
} as const satisfies IncomingEdgePolicy<"person", OperationDisposition>;

export const PERSON_MERGE_EDGE_POLICY = {
  "FundingSource.personId": {
    code: "merge-funding-sources",
    effect: "move-dedupe",
    description:
      "Move evidence and attributions to the survivor's funding source, then retire the duplicate companion.",
  },
  "ExpenseAttribution.personId": {
    code: "merge-beneficiary-attributions",
    effect: "move-dedupe",
    description:
      "Repoint beneficiary shares and combine weights when the survivor already has a share on the same expense.",
  },
  "FinancialAccountPerson.personId": {
    code: "merge-account-memberships",
    effect: "move-dedupe",
    description:
      "Repoint account memberships and preserve the survivor's existing role if both people are attached.",
  },
} as const satisfies IncomingEdgePolicy<"person", OperationDisposition>;

const columns = {
  id: person.id,
  shortcode: person.shortcode,
  name: person.name,
  kind: person.kind,
  notes: person.notes,
  userId: person.userId,
  createdAt: person.createdAt,
  updatedAt: person.updatedAt,
  userName: user.name,
  userEmail: user.email,
} as const;

type PersonRow = {
  id: PersonId;
  shortcode: string;
  name: string;
  kind: PersonOut["kind"];
  notes: string | null;
  userId: string | null;
  createdAt: Date;
  updatedAt: Date;
  userName: string | null;
  userEmail: string | null;
};

const toOut = (row: PersonRow): PersonOut =>
  personOut.parse({
    id: unsafePersonShortcode(row.shortcode),
    name: row.name,
    kind: row.kind,
    notes: row.notes,
    linkedUser:
      row.userName && row.userEmail
        ? { name: row.userName, email: row.userEmail }
        : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

const getById = async (
  db: Database | DrizzleTransaction,
  id: PersonId,
): Promise<PersonRow | undefined> => {
  const [row] = await unwrapDb(db)
    .select(columns)
    .from(person)
    .leftJoin(user, eq(person.userId, user.id))
    .where(and(eq(person.id, id), notDeleted(person)))
    .limit(1);
  return row;
};

const reader = createEntityReader<PersonRow, PersonOut, PersonId>({
  entity: "person",
  fetchById: getById,
  fromDB: (_db, row) => toOut(row),
});

export const getPersonByShortcode = async (db: Database, code: string) =>
  reader.getByShortcode(db, code);

export async function listPeople(
  db: Database,
  filters: PersonFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
) {
  const where = and(
    notDeleted(person),
    ...auditDateWhereConditions(person, filters),
    filters.search
      ? ilike(person.name, `%${filters.search.trim()}%`)
      : undefined,
    filters.kind
      ? inArray(person.kind, filters.kind as PersonOut["kind"][])
      : undefined,
    filters.linkedUserPresenceFilter === "has"
      ? not(isNull(person.userId))
      : undefined,
    filters.linkedUserPresenceFilter === "none"
      ? isNull(person.userId)
      : undefined,
  );
  const order = sorts[0] ?? { orderBy: "name", direction: "asc" as const };
  const orderColumn =
    {
      name: person.name,
      kind: person.kind,
      createdAt: person.createdAt,
      updatedAt: person.updatedAt,
    }[order.orderBy as "name"] ?? person.name;
  const { take, skip } = buildTakeSkip(pagination);
  const { data, count } = await executeListQueryWithCount(
    getDb(db)
      .select(columns)
      .from(person)
      .leftJoin(user, eq(person.userId, user.id))
      .where(where)
      .orderBy(
        order.direction === "desc" ? desc(orderColumn) : asc(orderColumn),
      )
      .limit(take)
      .offset(skip),
    countWhere(db, person, where),
  );
  return { data: data.map(toOut), count };
}

export async function createPerson(
  db: Database,
  data: PersonCreateInput,
  actor: ActorContext,
) {
  const id = await withTransaction(db, async (tx) => {
    const created = await insertWithShortcode(tx, "person", data);
    await tx
      .insert(fundingSource)
      .values({ kind: "person", personId: created.id });
    await logAuditEntry(tx, actor, {
      entityType: "person",
      entityId: created.id,
      action: "create",
    });
    return created.id;
  });
  return { output: await reader.getByID(db, id), entityId: id };
}

export async function updatePerson(
  db: Database,
  id: PersonShortcode,
  data: PersonUpdateData,
  actor: ActorContext,
) {
  const personId = await resolveOrThrow(db, "person", id);
  await withTransaction(db, async (tx) => {
    const before = await getById(tx, personId);
    if (!before)
      throw createAppError("PERSON_NOT_FOUND", `Person not found: ${id}`);
    const values = buildPartialUpdateValues(data);
    await tx
      .update(person)
      .set(values)
      .where(and(eq(person.id, personId), notDeleted(person)));
    const changes = computeChanges(before, { ...before, ...values }, [
      "name",
      "kind",
      "notes",
    ]);
    if (changes)
      await logAuditEntry(tx, actor, {
        entityType: "person",
        entityId: personId,
        action: "update",
        changes,
      });
  });
  return { output: await reader.getByID(db, personId), entityId: personId };
}

export async function linkCurrentUserToPerson(
  db: Database,
  id: PersonShortcode,
  actor: ActorContext,
) {
  const personId = await resolveOrThrow(db, "person", id);
  await withTransaction(db, async (tx) => {
    await lockAndValidateForDelete(tx, person, [personId], "Person");
    const before = await getById(tx, personId);
    if (!before)
      throw createAppError("PERSON_NOT_FOUND", `Person not found: ${id}`);
    if (before.userId && before.userId !== actor.userId)
      throw createAppError(
        "PERSON_USER_LINK_CONFLICT",
        "This person is already linked to another user.",
      );
    if (before.userId === actor.userId) return;
    const [conflict] = await tx
      .select({ id: person.id })
      .from(person)
      .where(
        and(
          eq(person.userId, actor.userId),
          notDeleted(person),
          not(eq(person.id, personId)),
        ),
      )
      .limit(1);
    if (conflict)
      throw createAppError(
        "PERSON_USER_LINK_CONFLICT",
        "The current user is already linked to another person.",
      );
    await tx
      .update(person)
      .set({ userId: actor.userId })
      .where(and(eq(person.id, personId), notDeleted(person)));
    await logAuditEntry(tx, actor, {
      entityType: "person",
      entityId: personId,
      action: "update",
      changes: { userId: { from: before.userId, to: actor.userId } },
    });
  });
  return await reader.getByID(db, personId);
}

export async function unlinkPersonUser(
  db: Database,
  id: PersonShortcode,
  actor: ActorContext,
) {
  const personId = await resolveOrThrow(db, "person", id);
  await withTransaction(db, async (tx) => {
    const before = await getById(tx, personId);
    if (!before)
      throw createAppError("PERSON_NOT_FOUND", `Person not found: ${id}`);
    await tx
      .update(person)
      .set({ userId: null })
      .where(and(eq(person.id, personId), notDeleted(person)));
    await logAuditEntry(tx, actor, {
      entityType: "person",
      entityId: personId,
      action: "update",
      changes: { userId: { from: before.userId, to: null } },
    });
  });
  return await reader.getByID(db, personId);
}

export async function deletePeople(
  db: Database,
  codes: PersonShortcode[],
  actor: ActorContext,
) {
  const ids = uniq(
    await Promise.all(codes.map((code) => resolveOrThrow(db, "person", code))),
  );
  return await withTransaction(db, async (tx) => {
    await lockAndValidateForDelete(tx, person, ids, "Person");
    const [beneficiaries, memberships] = await Promise.all([
      countByTarget(tx, expenseAttribution, expenseAttribution.personId, ids),
      countByTarget(
        tx,
        financialAccountPerson,
        financialAccountPerson.personId,
        ids,
      ),
    ]);
    if (
      Object.values(beneficiaries).some(Boolean) ||
      Object.values(memberships).some(Boolean)
    ) {
      throw createAppError(
        "PERSON_HAS_LEDGER_EDGES",
        "Cannot delete a person with live beneficiary attributions or account memberships.",
      );
    }
    const sources = await tx
      .select({ id: fundingSource.id })
      .from(fundingSource)
      .where(
        and(inArray(fundingSource.personId, ids), notDeleted(fundingSource)),
      );
    const sourceIds = sources.map((row) => row.id);
    if (sourceIds.length) {
      const [accounts, funders, transfers] = await Promise.all([
        tx
          .select({ id: financialAccount.id })
          .from(financialAccount)
          .where(
            and(
              inArray(financialAccount.fundingSourceId, sourceIds),
              notDeleted(financialAccount),
            ),
          ),
        tx
          .select({ id: expenseAttribution.id })
          .from(expenseAttribution)
          .where(
            and(
              inArray(expenseAttribution.fundingSourceId, sourceIds),
              notDeleted(expenseAttribution),
            ),
          ),
        tx
          .select({ id: fundingTransfer.id })
          .from(fundingTransfer)
          .where(
            and(
              or(
                inArray(fundingTransfer.fromSourceId, sourceIds),
                inArray(fundingTransfer.toSourceId, sourceIds),
              ),
              notDeleted(fundingTransfer),
            ),
          ),
      ]);
      if (accounts.length || funders.length || transfers.length)
        throw createAppError(
          "PERSON_HAS_LEDGER_EDGES",
          "Cannot delete a person whose funding source still has financial evidence.",
        );
      await tx
        .update(fundingSource)
        .set({ deletedAt: new Date() })
        .where(inArray(fundingSource.id, sourceIds));
    }
    return await removeEntity(tx, {
      entity: "person",
      ids,
      removal: "soft",
      actor,
    });
  });
}

export const previewDeletePeople = async (
  db: Database | DrizzleTransaction,
  ids: PersonId[],
): Promise<{
  blockers: import("@cubby/schemas/entity-integrity").ImpactItem[];
  changes: import("@cubby/schemas/entity-integrity").ImpactItem[];
}> => {
  if (ids.length === 0) return { blockers: [], changes: [] };
  const client = unwrapDb(db);
  return {
    blockers: present([
      impact({
        disposition: PERSON_DELETE_EDGE_POLICY["ExpenseAttribution.personId"],
        edgeKey: "ExpenseAttribution.personId",
        label: "beneficiary attributions",
        byTargetId: await countByTarget(
          client,
          expenseAttribution,
          expenseAttribution.personId,
          ids,
        ),
      }),
      impact({
        disposition:
          PERSON_DELETE_EDGE_POLICY["FinancialAccountPerson.personId"],
        edgeKey: "FinancialAccountPerson.personId",
        label: "account memberships",
        byTargetId: await countByTarget(
          client,
          financialAccountPerson,
          financialAccountPerson.personId,
          ids,
        ),
      }),
    ]),
    changes: present([
      impact({
        disposition: PERSON_DELETE_EDGE_POLICY["FundingSource.personId"],
        edgeKey: "FundingSource.personId",
        label: "private funding sources",
        byTargetId: await countByTarget(
          client,
          fundingSource,
          fundingSource.personId,
          ids,
        ),
      }),
    ]),
  };
};

export const previewMergePeople = async (
  db: Database | DrizzleTransaction,
  input: { keepId: PersonId; mergeIds: PersonId[] },
): Promise<{
  blockers: import("@cubby/schemas/entity-integrity").ImpactItem[];
  changes: import("@cubby/schemas/entity-integrity").ImpactItem[];
}> => {
  const client = unwrapDb(db);
  return {
    blockers: [],
    changes: present([
      impact({
        disposition: PERSON_MERGE_EDGE_POLICY["ExpenseAttribution.personId"],
        edgeKey: "ExpenseAttribution.personId",
        label: "beneficiary attributions",
        byTargetId: await countByTarget(
          client,
          expenseAttribution,
          expenseAttribution.personId,
          input.mergeIds,
        ),
      }),
      impact({
        disposition:
          PERSON_MERGE_EDGE_POLICY["FinancialAccountPerson.personId"],
        edgeKey: "FinancialAccountPerson.personId",
        label: "account memberships",
        byTargetId: await countByTarget(
          client,
          financialAccountPerson,
          financialAccountPerson.personId,
          input.mergeIds,
        ),
      }),
      impact({
        disposition: PERSON_MERGE_EDGE_POLICY["FundingSource.personId"],
        edgeKey: "FundingSource.personId",
        label: "private funding sources",
        byTargetId: await countByTarget(
          client,
          fundingSource,
          fundingSource.personId,
          input.mergeIds,
        ),
      }),
    ]),
  };
};

export async function mergePeople(
  db: Database,
  input: { keepId: PersonShortcode; mergeIds: PersonShortcode[] },
  actor: ActorContext,
) {
  const { keepId, loserIds } = await resolveMergeTargets(db, {
    entity: "person",
    ...input,
  });
  let summary: PersonMergeSummaryOut | undefined;
  await withTransaction(db, async (tx) => {
    await lockAndValidateForDelete(tx, person, [keepId, ...loserIds], "Person");
    const people = await tx
      .select()
      .from(person)
      .where(inArray(person.id, [keepId, ...loserIds]));
    const keeper = people.find((row) => row.id === keepId)!;
    const losers = people.filter((row) => loserIds.includes(row.id));
    if (losers.some((row) => row.kind !== keeper.kind))
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        "People of different kinds cannot be merged.",
      );
    if (
      keeper.userId &&
      losers.some((row) => row.userId && row.userId !== keeper.userId)
    )
      throw createAppError(
        "PERSON_USER_LINK_CONFLICT",
        "Cannot merge people linked to different users.",
      );
    const sources = await tx
      .select()
      .from(fundingSource)
      .where(
        and(
          inArray(fundingSource.personId, [keepId, ...loserIds]),
          notDeleted(fundingSource),
        ),
      );
    const keeperSource = sources.find((row) => row.personId === keepId);
    if (!keeperSource)
      throw new Error("Live person is missing its funding source");
    const loserSources = sources.filter((row) =>
      loserIds.includes(row.personId!),
    );
    let beneficiaryEdgesRepointed = 0;
    let accountEdgesRepointed = 0;
    for (const loser of loserIds) {
      const beneficiaryRows = await tx
        .select()
        .from(expenseAttribution)
        .where(
          and(
            eq(expenseAttribution.personId, loser),
            notDeleted(expenseAttribution),
          ),
        );
      for (const row of beneficiaryRows) {
        const [existing] = await tx
          .select()
          .from(expenseAttribution)
          .where(
            and(
              eq(expenseAttribution.expenseId, row.expenseId),
              eq(expenseAttribution.role, row.role),
              eq(expenseAttribution.personId, keepId),
              notDeleted(expenseAttribution),
            ),
          );
        if (existing) {
          await tx
            .update(expenseAttribution)
            .set({
              weight: sql`${expenseAttribution.weight} + ${row.weight}`,
            })
            .where(eq(expenseAttribution.id, existing.id));
          await tx
            .update(expenseAttribution)
            .set({ deletedAt: new Date() })
            .where(eq(expenseAttribution.id, row.id));
        } else
          await tx
            .update(expenseAttribution)
            .set({ personId: keepId })
            .where(eq(expenseAttribution.id, row.id));
        beneficiaryEdgesRepointed++;
      }
      const membershipRows = await tx
        .select()
        .from(financialAccountPerson)
        .where(
          and(
            eq(financialAccountPerson.personId, loser),
            notDeleted(financialAccountPerson),
          ),
        );
      for (const row of membershipRows) {
        const [existing] = await tx
          .select()
          .from(financialAccountPerson)
          .where(
            and(
              eq(financialAccountPerson.accountId, row.accountId),
              eq(financialAccountPerson.personId, keepId),
              notDeleted(financialAccountPerson),
            ),
          );
        if (existing)
          await tx
            .update(financialAccountPerson)
            .set({ deletedAt: new Date() })
            .where(eq(financialAccountPerson.id, row.id));
        else
          await tx
            .update(financialAccountPerson)
            .set({ personId: keepId })
            .where(eq(financialAccountPerson.id, row.id));
        accountEdgesRepointed++;
      }
    }
    let fundingEdgesRepointed = 0;
    let transferEdgesRepointed = 0;
    for (const source of loserSources) {
      const folded = await foldPersonFundingSourceForMerge(tx, {
        keeperSourceId: keeperSource.id,
        loserSourceId: source.id,
      });
      fundingEdgesRepointed += folded.fundingEdgesRepointed;
      transferEdgesRepointed += folded.transferEdgesRepointed;
    }
    const carried =
      !keeper.userId && losers.find((row) => row.userId)
        ? { userId: losers.find((row) => row.userId)!.userId }
        : {};
    if (Object.keys(carried).length)
      await tx.update(person).set(carried).where(eq(person.id, keepId));
    const result = await finalizeMerge(tx, {
      entity: "person",
      table: person,
      keepId,
      loserIds,
      removal: "soft",
      actor,
      survivorChanges: { mergedFrom: { from: null, to: loserIds } },
    });
    summary = personMergeSummaryOut.parse({
      keepId: input.keepId,
      deletedIds: input.mergeIds,
      merged: result.removed,
      beneficiaryEdgesRepointed,
      fundingEdgesRepointed,
      accountEdgesRepointed,
      transferEdgesRepointed,
      carriedFields: Object.keys(carried),
    });
  });
  return { person: await reader.getByID(db, keepId), mergeSummary: summary! };
}
