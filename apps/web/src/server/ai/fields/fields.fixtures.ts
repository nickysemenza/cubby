/** Synthetic seeds pass field assignments through the same boundary as writers. */
import { systemActor } from "@cubby/schemas/context";
import { parseEntityId } from "@cubby/schemas/identifiers";
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
  if (entity === "email") {
    const { appendEmailIdentity } =
      await import("~/server/domains/purchase-import/repo/order-evidence");
    const { email } = await import("~/server/db/schema");
    // SAFETY: this entity literal selects the Email insert model and result.
    const data = values as ShortcodeInsertValues<"email">;
    const id = data.id ?? parseEntityId("email", crypto.randomUUID());
    const result = await appendEmailIdentity(db, {
      where: eq(email.id, id),
      values: () => ({ ...data, id }),
    });
    const { reconcileNow } = await import("~/server/kernel/api");
    await reconcileNow(db, [{ kind: "emailState", key: result.row.id }]);
    // SAFETY: the entity literal selects the same output model as the generic caller.
    return {
      ...result.row,
      shortcode: parseShortcodeFor(entity, result.row.shortcode),
    } as ShortcodeRowFor<T>;
  }
  if (entity === "shipment") {
    const { appendShipmentHeader } =
      await import("~/server/domains/shipment/repo/shipment-mutations");
    // SAFETY: this entity literal selects the Shipment insert model and result.
    const data = values as ShortcodeInsertValues<"shipment">;
    const row = await appendShipmentHeader(db, {
      values: data,
      sourceKey: "manual",
      packageKey: crypto.randomUUID(),
      manual: true,
    });
    // SAFETY: the entity literal selects the same output model as the generic caller.
    return {
      ...row,
      shortcode: parseShortcodeFor(entity, row.shortcode),
    } as ShortcodeRowFor<T>;
  }
  if (entity === "ledgerTransfer") {
    const { createTransferEvent } =
      await import("~/server/domains/ledger-transfer/repo/transfer-mutations");
    const { ledgerTransfer } = await import("~/server/db/schema");
    const { repositoryQueries } =
      await import("~/server/db/repository-access.boundary");
    // SAFETY: this entity literal selects the LedgerTransfer insert model.
    const data = values as ShortcodeInsertValues<"ledgerTransfer">;
    const id = await createTransferEvent(db, data, [], systemActor());
    const [row] = await repositoryQueries(db)
      .select()
      .from(ledgerTransfer)
      .where(eq(ledgerTransfer.id, parseEntityId("ledgerTransfer", id)));
    if (!row) throw new Error("Synthetic transfer is missing");
    // SAFETY: the entity literal selects the same output model as the generic caller.
    return {
      ...row,
      shortcode: parseShortcodeFor(entity, row.shortcode),
    } as ShortcodeRowFor<T>;
  }
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
