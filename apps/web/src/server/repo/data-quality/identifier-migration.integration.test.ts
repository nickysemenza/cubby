import { readFileSync } from "node:fs";

import { eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { expect, it } from "vitest";

import { dataExceptionRecord } from "~/server/db/schema";
import { unwrapDb } from "~/server/repo/database-helpers";
import {
  createProductFixture,
  makeProductInput,
} from "~/server/repo/repo.fixtures";

import { loadDataQualities } from "./hydrate";

// Failure modes: retired model exceptions break hydration, consolidation
// loses notes, or a model-only exception incorrectly accepts the absence of
// every identifier. Active and stale external-ID exceptions keep their basis.
const ctx = withTestDb();

it("consolidates retired model exceptions without losing evidence or promoting acceptance", async () => {
  const paired = await createProductFixture(
    ctx.db,
    makeProductInput({ name: "Synthetic paired exceptions", model: null }),
    ctx.actor,
  );
  const modelOnly = await createProductFixture(
    ctx.db,
    makeProductInput({ name: "Synthetic model exception", model: null }),
    ctx.actor,
  );
  const db = unwrapDb(ctx.db);
  await db.execute(
    sql`ALTER TABLE "DataException" DROP CONSTRAINT IF EXISTS "DataException_no_retired_model_check"`,
  );
  await db.insert(dataExceptionRecord).values([
    {
      entityKind: "product",
      entityId: paired.entityId,
      check: "product_external_id",
      reason: "unavailable",
      note: "Synthetic identifier search.",
      fingerprint: "product_external_id:false",
    },
    {
      entityKind: "product",
      entityId: paired.entityId,
      check: "product_model",
      reason: "not_issued",
      note: "Synthetic model search.",
      fingerprint: "product_model:legacy",
    },
    {
      entityKind: "product",
      entityId: modelOnly.entityId,
      check: "product_model",
      reason: "unavailable",
      note: "Synthetic standalone model search.",
      fingerprint: "product_model:legacy",
    },
  ]);
  const migration = readFileSync(
    new URL(
      "../../../../drizzle/0054_product_identifier_sufficiency.sql",
      import.meta.url,
    ),
    "utf8",
  );
  await db.transaction(async (tx) => {
    for (const statement of migration.split("--> statement-breakpoint"))
      await tx.execute(sql.raw(statement));
  });
  const rows = await db
    .select()
    .from(dataExceptionRecord)
    .where(eq(dataExceptionRecord.entityKind, "product"));
  expect(rows).toHaveLength(2);
  expect(rows.find((row) => row.entityId === paired.entityId)).toMatchObject({
    check: "product_external_id",
    fingerprint: "product_external_id:false",
    reason: "unavailable",
  });
  expect(rows.find((row) => row.entityId === paired.entityId)?.note).toContain(
    "Synthetic identifier search.",
  );
  expect(rows.find((row) => row.entityId === paired.entityId)?.note).toContain(
    "Synthetic model search.",
  );
  expect(
    rows.find((row) => row.entityId === modelOnly.entityId)?.note,
  ).toContain("Synthetic standalone model search.");
  const archived = rows
    .find((row) => row.entityId === paired.entityId)
    ?.note.split("Former model exception: ")[1];
  expect(JSON.parse(archived ?? "null")).toMatchObject({
    check: "product_model",
    reason: "not_issued",
    note: "Synthetic model search.",
    fingerprint: "product_model:legacy",
  });
  await expect(
    db.insert(dataExceptionRecord).values({
      entityKind: "product",
      entityId: paired.entityId,
      check: "product_model",
      reason: "unavailable",
      note: "Synthetic obsolete writer.",
      fingerprint: "legacy",
    }),
  ).rejects.toMatchObject({
    cause: {
      code: "23514",
      constraint: "DataException_no_retired_model_check",
    },
  });
  const quality = await loadDataQualities(ctx.db, "product", [
    paired.entityId,
    modelOnly.entityId,
  ]);
  expect(quality.get(paired.entityId)?.exceptions).toContainEqual(
    expect.objectContaining({ check: "product_external_id", state: "active" }),
  );
  expect(quality.get(modelOnly.entityId)?.exceptions).toContainEqual(
    expect.objectContaining({ check: "product_external_id", state: "stale" }),
  );
  expect(
    quality.get(modelOnly.entityId)?.gaps.map((gap) => gap.check),
  ).toContain("product_external_id");
});
