/** Synthetic seeds pass field assignments through the same boundary as writers. */
import { systemActor } from "@cubby/schemas/context";
import { parseShortcodeFor, type ShortcodeType } from "@cubby/shared";
import { eq } from "drizzle-orm";

import type { Database } from "~/server/db/database";
import { withTransactionDatabase } from "~/server/db/helpers";
import {
  insertWithShortcode,
  type ShortcodeInsertValues,
  type ShortcodeGeneratorPort,
  type ShortcodeRowFor,
} from "~/server/generic/shortcode/repo/shortcode-utils";

import { holdFieldsValues } from "./repo/field-decisions";

export async function insertFieldsFixture<T extends ShortcodeType>(
  db: Database,
  entity: T,
  values: ShortcodeInsertValues<T>,
  generator?: ShortcodeGeneratorPort,
): Promise<ShortcodeRowFor<T>> {
  if (
    entity === "purchase" ||
    entity === "expense" ||
    entity === "financialTransaction"
  ) {
    const { createPurchaseEventRecord } =
      await import("~/server/domains/financial-transaction/repo/purchase-event-mutations");
    const { seedBankTransaction } =
      await import("~/server/domains/financial-transaction/repo/bank.fixtures");
    // SAFETY: the entity literal selects the same insert model as the generic caller.
    const row =
      entity === "financialTransaction"
        ? await seedBankTransaction(
            db,
            values as ShortcodeInsertValues<"financialTransaction">,
          )
        : entity === "purchase"
          ? await createPurchaseEventRecord(
              db,
              "purchase",
              values as ShortcodeInsertValues<"purchase">,
            )
          : await createPurchaseEventRecord(
              db,
              "expense",
              values as ShortcodeInsertValues<"expense">,
            );
    const { repositoryQueries } =
      await import("~/server/db/repository-access.boundary");
    const { SHORTCODE_TABLE } =
      await import("~/server/generated/shortcode-tables.gen");
    const table =
      entity === "purchase"
        ? SHORTCODE_TABLE.purchase
        : entity === "expense"
          ? SHORTCODE_TABLE.expense
          : SHORTCODE_TABLE.financialTransaction;
    const metadata = {
      ...("deletedAt" in values &&
      (values.deletedAt instanceof Date || values.deletedAt === null)
        ? { deletedAt: values.deletedAt }
        : {}),
      ...("createdAt" in values && values.createdAt instanceof Date
        ? { createdAt: values.createdAt }
        : {}),
      ...("updatedAt" in values && values.updatedAt instanceof Date
        ? { updatedAt: values.updatedAt }
        : {}),
    };
    if (Object.keys(metadata).length)
      await repositoryQueries(db)
        .update(table)
        .set(metadata)
        .where(eq(table.id, row.id));
    // SAFETY: the same entity discriminant selected both writer and public shortcode.
    return {
      ...row,
      ...metadata,
      shortcode: parseShortcodeFor(entity, row.shortcode),
    } as ShortcodeRowFor<T>;
  }
  return withTransactionDatabase(db, async (tx) => {
    const held = holdFieldsValues(entity, values, "create");
    const row = await insertWithShortcode(tx, entity, held.values, generator);
    if (!row.id) throw new Error("Synthetic seed has no identity");
    await held.settle(tx, systemActor(), row.id);
    return {
      ...row,
      ...Object.fromEntries(
        Object.entries(values).filter(([key]) => held.held.includes(key)),
      ),
    };
  });
}

/** Seed an assignment on an existing synthetic row through the owning writer boundary. */
export async function setFieldsFixture(
  db: Database,
  entity: string,
  id: string,
  values: Readonly<Record<string, string | null>>,
) {
  await withTransactionDatabase(db, async (tx) => {
    await holdFieldsValues(entity, values).settle(tx, systemActor(), id);
  });
}

/** A local field producer runs the real reconciler and apply gate, without inference. */
export async function applyFieldAnswerFixture(
  db: Database,
  input: {
    entity: string;
    recordId: string;
    field: string;
    value: string | string[];
    confidence?: number;
    runnerUp?: { value: string; confidence: number };
  },
) {
  const { fieldAsk } = await import("./ask");
  const { fieldsReconciler, fieldsCapabilities } = await import("./reconciler");
  const { createKernel, defineModule } = await import("~/server/kernel/api");
  const { computeBatch } = await import("~/server/kernel/compute");
  const { repositoryQueries } =
    await import("~/server/db/repository-access.boundary");
  const ask = {
    ...fieldAsk,
    admit: async () => {},
    produce: async (request: import("./ask").FieldAskInput) => ({
      output: {
        proposal:
          request.recordId === input.recordId && request.field === input.field
            ? {
                value: input.value,
                label: null,
                confidence: input.confidence ?? 0.99,
                runnerUp: input.runnerUp
                  ? { ...input.runnerUp, label: null }
                  : null,
              }
            : null,
        outcome: "synthetic",
      },
    }),
  };
  const reconciler = fieldsReconciler();
  const kernel = createKernel([
    defineModule({
      name: "fields",
      asks: [ask],
      reconcilers: [reconciler],
      machinery: fieldsCapabilities(),
    }),
  ]);
  const scope = { kind: "fields", key: `${input.entity}:${input.recordId}` };
  const [computed] = await computeBatch(
    repositoryQueries(db),
    kernel.registry,
    reconciler,
    [scope],
    { db, locked: false, hideBaseline: false },
  );
  if (!computed || computed.error)
    throw new Error(
      `Synthetic field preparation failed: ${JSON.stringify(computed?.error)}`,
    );
  for (const missing of computed.missing) {
    if (missing.kind.feature !== ask.feature)
      throw new Error("Synthetic field fixture refuses another producer");
    await kernel.withAsk(db, ask, missing.envelope.input, { scopes: [scope] });
  }
  await kernel.reconcileNow(db, [scope]);
}
