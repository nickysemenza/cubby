import { systemActor, type ActorContext } from "@cubby/schemas/context";
import { parseShortcodeFor } from "@cubby/shared";
import {
  and,
  eq,
  inArray,
  type InferInsertModel,
  type InferSelectModel,
  type SQL,
  getTableColumns,
  sql,
} from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import {
  databaseForTransaction,
  isTransaction,
  unwrapDb,
  withTransaction,
} from "~/server/db/helpers";
import { textArrayParam } from "~/server/db/helpers/array-param";
import { evidenceBinding, recordKey } from "~/server/db/kernel-schema";
import { repositoryQueries } from "~/server/db/repository-access.boundary";
import type {
  purchaseEventTables,
  PurchaseEventTable,
} from "~/server/domains/financial-transaction/repo/purchase-event-records";
import { createAppError } from "~/server/errors/app-error";
import { jsonSnapshot } from "~/server/lib/canonical-json";

type Table<K extends PurchaseEventTable> =
  (typeof purchaseEventTables)[K]["table"];
type SavedMap = {
  purchase: InferSelectModel<Table<"purchase">> & {
    shortcode: import("@cubby/shared").ShortcodeFor<"purchase">;
  };
  expense: InferSelectModel<Table<"expense">> & {
    shortcode: import("@cubby/shared").ShortcodeFor<"expense">;
  };
  ExpenseAttribution: InferSelectModel<Table<"ExpenseAttribution">>;
  FinancialTransactionAllocation: InferSelectModel<
    Table<"FinancialTransactionAllocation">
  >;
};
type Saved<K extends PurchaseEventTable> = SavedMap[K];
const jsonValues = (
  values: Parameters<import("~/server/kernel/api").Pure["record"]>[2],
) =>
  jsonSnapshot.parse(
    Object.fromEntries(
      Object.entries(values)
        .filter(
          ([field, value]) =>
            value !== undefined &&
            ![
              "id",
              "shortcode",
              "createdAt",
              "updatedAt",
              "deletedAt",
            ].includes(field),
        )
        .map(([field, value]) => [
          field,
          typeof value === "bigint" ? value.toString() : value,
        ]),
    ),
  );

/** Immutable typed entries; an import's subsequent corrections are Decisions. */
export async function createPurchaseEventRecords<K extends PurchaseEventTable>(
  db: Database | DrizzleTransaction,
  entity: K,
  inputs: readonly Omit<InferInsertModel<Table<K>>, "id" | "shortcode">[],
  actor: ActorContext = systemActor(),
  options: { basis?: "manual" | "decision" } = {},
): Promise<Saved<K>[]> {
  if (!inputs.length) return [];
  return withTransaction(
    isTransaction(db) ? databaseForTransaction(db) : db,
    async (tx) => {
      const database = databaseForTransaction(tx);
      const { purchaseEventTables } =
        await import("~/server/domains/financial-transaction/repo/purchase-event-records");
      const { target, table } = purchaseEventTables[entity];
      const { append, decide, evidenceRow, reconcileNow } =
        await import("~/server/kernel/api");
      const { manualTransactionEvidence } =
        await import("~/server/domains/financial-transaction/repo/manual-evidence");
      const parentIds = inputs.flatMap((values) =>
        "purchaseId" in values && typeof values.purchaseId === "string"
          ? [values.purchaseId]
          : [],
      );
      const parents =
        entity === "expense" && parentIds.length
          ? await repositoryQueries(database)
              .select()
              .from(recordKey)
              .where(
                and(
                  eq(recordKey.entity, "purchase"),
                  inArray(recordKey.entityId, parentIds),
                ),
              )
          : [];
      const entries = inputs.map((values) => {
        const id = crypto.randomUUID();
        return {
          id,
          key:
            ("purchaseId" in values && typeof values.purchaseId === "string"
              ? parents.find((parent) => parent.entityId === values.purchaseId)
                  ?.scopeKey
              : null) ?? id,
          naturalKey: `manual:${id}`,
          values: jsonValues(values),
        };
      });
      const decidedCreation =
        options.basis === "decision" ||
        entity === "FinancialTransactionAllocation" ||
        entity === "ExpenseAttribution" ||
        actor.channel === "system";
      if (!decidedCreation)
        await append(
          database,
          entries.map((entry) =>
            evidenceRow(manualTransactionEvidence, {
              id: entry.id,
              entity,
              userId: actor.userId,
              payload: {
                purchaseEvent: entry.key,
                table: target.name,
                naturalKey: entry.naturalKey,
                values: entry.values,
              },
            }),
          ),
        );
      const accepted = parents.some((parent) => !parent.minted)
        ? await repositoryQueries(database)
            .select({ key: evidenceBinding.scopeKey })
            .from(evidenceBinding)
            .where(
              and(
                eq(evidenceBinding.scopeKind, "purchaseEvent"),
                eq(evidenceBinding.basis, "baseline"),
                inArray(
                  evidenceBinding.scopeKey,
                  entries.map((entry) => entry.key),
                ),
              ),
            )
        : [];
      await decide(
        database,
        actor,
        entries
          .filter(
            (entry) =>
              decidedCreation ||
              accepted.some((scope) => scope.key === entry.key),
          )
          .map((entry) => ({
            channel: "assignment",
            kind: "set",
            subject: `purchaseEvent:${entry.key}`,
            field: `record:${target.name}:${entry.naturalKey}`,
            value: {
              table: target.name,
              naturalKey: entry.naturalKey,
              values: entry.values,
            },
            scopes: [{ kind: "purchaseEvent", key: entry.key }],
          })),
      );
      const outcomes = await reconcileNow(
        database,
        entries.map((entry) => ({ kind: "purchaseEvent", key: entry.key })),
      );
      const q = repositoryQueries(database);
      const owned = await q
        .select()
        .from(recordKey)
        .where(
          and(
            eq(recordKey.scopeKind, "purchaseEvent"),
            inArray(
              recordKey.scopeKey,
              entries.map((entry) => entry.key),
            ),
          ),
        );
      const ids = entries.map(
        (entry) =>
          owned.find(
            (row) =>
              row.scopeKey === entry.key &&
              row.naturalKey === entry.naturalKey &&
              row.entity === (target.entity ?? target.name),
          )?.entityId,
      );
      if (ids.some((id) => !id))
        throw createAppError(
          "CONSTRAINT_VIOLATION",
          outcomes
            .flatMap(
              (outcome) =>
                outcome.error ?? outcome.gaps.map((gap) => gap.input),
            )
            .join("; ") || "The purchase event is waiting to reconcile.",
        );
      const where = sql`${table.id} = ANY(${textArrayParam(ids.flatMap((id) => (id ? [id] : [])))}::uuid[])`;
      const readers = {
        purchase: async () =>
          (
            await q
              .select()
              .from(purchaseEventTables.purchase.table)
              .where(where)
          ).map((row) => ({
            ...row,
            shortcode: parseShortcodeFor("purchase", row.shortcode),
          })),
        expense: async () =>
          (
            await q
              .select()
              .from(purchaseEventTables.expense.table)
              .where(where)
          ).map((row) => ({
            ...row,
            shortcode: parseShortcodeFor("expense", row.shortcode),
          })),
        ExpenseAttribution: () =>
          q
            .select()
            .from(purchaseEventTables.ExpenseAttribution.table)
            .where(where),
        FinancialTransactionAllocation: () =>
          q
            .select()
            .from(purchaseEventTables.FinancialTransactionAllocation.table)
            .where(where),
      };
      const saved = await readers[entity]();
      // SAFETY: the reader is selected by the same entity key as the return type.
      return ids.map((id) => saved.find((row) => row.id === id)!) as Saved<K>[];
    },
  );
}

/** All authorship, including order-import updates, passes through the owning scope. */
export async function updatePurchaseEventRecords<K extends PurchaseEventTable>(
  db: Database,
  entity: K,
  changes: readonly {
    id: string;
    values: Partial<InferInsertModel<Table<K>>>;
  }[],
  actor: ActorContext,
): Promise<void> {
  if (!changes.length) return;
  const { purchaseEventTables } =
    await import("~/server/domains/financial-transaction/repo/purchase-event-records");
  const { target } = purchaseEventTables[entity];
  const owners = await repositoryQueries(db)
    .select()
    .from(recordKey)
    .where(
      and(
        eq(recordKey.entity, target.entity ?? target.name),
        inArray(
          recordKey.entityId,
          changes.map((change) => change.id),
        ),
      ),
    );
  if (
    changes.some(
      (change) => !owners.some((owner) => owner.entityId === change.id),
    )
  )
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      `The ${target.name} has no purchase-event ownership.`,
    );
  const { decide, reconcileNow, recordSubject } =
    await import("~/server/kernel/api");
  await decide(
    db,
    actor,
    changes.flatMap((change) =>
      Object.entries(change.values)
        .filter(
          ([field, value]) =>
            value !== undefined && target.columns.includes(field),
        )
        .map(([field, value]) => ({
          channel: "assignment",
          kind: value === null ? "none" : "set",
          subject: recordSubject(target.entity ?? target.name, change.id),
          field,
          value: jsonSnapshot.parse(
            typeof value === "bigint" ? value.toString() : value,
          ),
        })),
    ),
  );
  const outcomes = await reconcileNow(
    db,
    owners.map((owner) => ({ kind: owner.scopeKind, key: owner.scopeKey })),
  );
  const failure = outcomes.find(
    (outcome) => outcome.status === "failed" || outcome.status === "conflict",
  );
  if (failure)
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      failure.error ??
        "The purchase event changed while applying the decision.",
    );
}

/** Builder callers retain their predicate; its next values become decisions. */
export async function updatePurchaseEventWhere<K extends PurchaseEventTable>(
  db: Database | DrizzleTransaction,
  entity: K,
  values: Partial<{
    [P in keyof InferInsertModel<Table<K>>]:
      | InferInsertModel<Table<K>>[P]
      | SQL;
  }>,
  where: SQL | undefined,
  actor: ActorContext = systemActor(),
): Promise<InferSelectModel<Table<K>>[]> {
  const database = isTransaction(db) ? databaseForTransaction(db) : db;
  const { purchaseEventTables } =
    await import("~/server/domains/financial-transaction/repo/purchase-event-records");
  const { table, target } = purchaseEventTables[entity];
  const columns = getTableColumns(table);
  const entries = Object.entries(values).filter(
    ([, value]) => value !== undefined,
  );
  const selected = {
    id: table.id,
    ...Object.fromEntries(
      entries
        .filter(([field]) => target.columns.includes(field))
        .map(([field, value]) => {
          const column = Object.entries(columns).find(
            ([name]) => name === field,
          )?.[1];
          if (!column)
            throw new Error(`Unknown ${target.name} column ${field}`);
          return [
            field,
            sql`CAST(${value} AS ${sql.raw(column.getSQLType())})`
              .mapWith(column)
              .as(field),
          ];
        }),
    ),
  };
  const rows = await repositoryQueries(database)
    .select(selected)
    .from(table)
    .where(where);
  await updatePurchaseEventRecords(
    database,
    entity,
    rows.map((row) => ({
      id: row.id,
      // SAFETY: selected expressions have the insert column names supplied above.
      values: Object.fromEntries(
        Object.entries(row).filter(([field]) => field !== "id"),
      ) as Partial<InferInsertModel<Table<K>>>,
    })),
    actor,
  );
  const authored = entries.filter(([field]) => !target.columns.includes(field));
  if (rows.length && authored.length)
    await unwrapDb(database).execute(
      sql`UPDATE ${table} SET ${sql.join(
        authored.map(([field, value]) => {
          const column = Object.entries(columns).find(
            ([name]) => name === field,
          )?.[1];
          if (!column)
            throw new Error(`Unknown ${target.name} column ${field}`);
          return sql`${sql.identifier(column.name)} = ${value}`;
        }),
        sql`, `,
      )} WHERE ${table.id} = ANY(${textArrayParam(rows.map((row) => row.id))}::uuid[])`,
    );
  if (!rows.length) return [];
  // SAFETY: these are the table's typed rows, with its column decoding intact.
  return (await repositoryQueries(database)
    .select()
    .from(table)
    .where(
      sql`${table.id} = ANY(${textArrayParam(rows.map((row) => row.id))}::uuid[])`,
    )) as InferSelectModel<Table<K>>[];
}

export async function createPurchaseEventRecord<K extends PurchaseEventTable>(
  db: Database | DrizzleTransaction,
  entity: K,
  values: Omit<InferInsertModel<Table<K>>, "id" | "shortcode">,
  actor: ActorContext = systemActor(),
  options: { basis?: "manual" | "decision" } = {},
): Promise<Saved<K>> {
  const [row] = await createPurchaseEventRecords(
    db,
    entity,
    [values],
    actor,
    options,
  );
  return row!;
}

export async function insertPurchaseEventRows<K extends PurchaseEventTable>(
  db: Database | DrizzleTransaction,
  entity: K,
  values:
    | Omit<InferInsertModel<Table<K>>, "id" | "shortcode">
    | readonly Omit<InferInsertModel<Table<K>>, "id" | "shortcode">[],
  actor: ActorContext = systemActor(),
): Promise<Saved<K>[]> {
  // SAFETY: Array.isArray does not narrow a readonly array in a generic union.
  const rows = (Array.isArray(values) ? values : [values]) as readonly Omit<
    InferInsertModel<Table<K>>,
    "id" | "shortcode"
  >[];
  return createPurchaseEventRecords(db, entity, rows, actor);
}

/** Removing an authored split is a rejection, so replay cannot resurrect it. */
export async function rejectPurchaseEventWhere<K extends PurchaseEventTable>(
  db: Database | DrizzleTransaction,
  entity: K,
  where: SQL | undefined,
  actor: ActorContext = systemActor(),
): Promise<void> {
  const database = isTransaction(db) ? databaseForTransaction(db) : db;
  const { purchaseEventTables } =
    await import("~/server/domains/financial-transaction/repo/purchase-event-records");
  const { table, target } = purchaseEventTables[entity];
  const rows = await repositoryQueries(database)
    .select({ id: table.id })
    .from(table)
    .where(where);
  const { decide, recordSubject } = await import("~/server/kernel/api");
  await decide(
    database,
    actor,
    rows.map((row) => ({
      channel: "rejection",
      kind: "reject",
      subject: recordSubject(target.entity ?? target.name, row.id),
    })),
  );
}
