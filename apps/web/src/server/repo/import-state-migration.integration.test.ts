import { readFileSync } from "node:fs";

import { runTargetDeviceWorkState } from "@cubby/schemas/photo-import-run";
import { runTargetState } from "@cubby/schemas/purchase-import";
import { runTargetEntityKind } from "@cubby/schemas/run-fields";
import { eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { photoRunImage, runOperation } from "~/server/db/schema";
import { startAgentRunFixture } from "~/server/purchase-import/import-run.fixtures";

import { getDb } from "./database-helpers";
import {
  createImageFixture,
  createProductFixture,
  makeProductInput,
} from "./repo.fixtures";
import { insertWithShortcode } from "./shortcode-utils";

describe("retired target ownership migration", () => {
  const ctx = withTestDb();
  it("preserves photo work and non-photo no-op receipts across repeat transforms", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic migration member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const run = await startAgentRunFixture(ctx.db, { ledgerPartyId: party.id });
    const image = await createImageFixture(ctx.db, "synthetic-migration-photo");
    const product = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic no-op subject" }),
      ctx.actor,
    );
    // Recreate the retired physical shape from its committed migration so the
    // transform is exercised after the current schema has dropped the table.
    const baseline = readFileSync(
      new URL("../../../drizzle/0000_baseline.sql", import.meta.url),
      "utf8",
    );
    const legacyDdl = baseline.match(
      /CREATE TABLE "RunTarget" \([\s\S]*?\n\);/,
    )?.[0];
    if (!legacyDdl) throw new Error("Legacy target DDL missing");
    await getDb(ctx.db).execute(
      sql.raw(
        legacyDdl.replace(
          'CREATE TABLE "RunTarget"',
          'CREATE TABLE IF NOT EXISTS "RunTarget"',
        ),
      ),
    );
    await getDb(ctx.db).execute(
      sql`ALTER TABLE "RunTarget" ADD COLUMN IF NOT EXISTS "workKey" text NOT NULL DEFAULT ''`,
    );
    const photoId = crypto.randomUUID();
    const genericId = crypto.randomUUID();
    await getDb(ctx.db).execute(
      sql`INSERT INTO "RunTarget" (id,"runId","entityKind","entityId","workKey",position,state,"targetFingerprint",warning,"deviceWorkState","deviceWorkAttempts") VALUES (${photoId}::uuid,${run.id}::uuid,${runTargetEntityKind.enum.image},${image.id}::uuid,${"photo"},3,${runTargetState.enum.unresolved},${"a".repeat(64)},'Synthetic missing label',${runTargetDeviceWorkState.enum.failed},2)`,
    );
    await getDb(ctx.db).execute(
      sql`INSERT INTO "RunTarget" (id,"runId","entityKind","entityId","workKey",state,"targetFingerprint",outcome,"completedAt") VALUES (${genericId}::uuid,${run.id}::uuid,${runTargetEntityKind.enum.product},${product.entityId}::uuid,'',${runTargetState.enum.completed},${"b".repeat(64)},'enriched',now())`,
    );
    const migration = readFileSync(
      new URL(
        "../../../drizzle/0035_email_import_cutover.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const transform = migration
      .split("-- BEGIN TARGET OWNERSHIP BACKFILL\n")[1]
      ?.split("-- END TARGET OWNERSHIP BACKFILL")[0];
    if (!transform) throw new Error("Target ownership data transform missing");
    const apply = async () => {
      for (const statement of transform
        .split("--> statement-breakpoint")
        .filter((value) => value.trim()))
        await getDb(ctx.db).execute(sql.raw(statement));
    };
    await apply();
    const read = async () => ({
      photos: await getDb(ctx.db)
        .select()
        .from(photoRunImage)
        .where(eq(photoRunImage.runId, run.id)),
      receipts: await getDb(ctx.db)
        .select()
        .from(runOperation)
        .where(eq(runOperation.runId, run.id)),
    });
    const first = await read();
    expect(first.photos).toEqual([
      expect.objectContaining({
        id: photoId,
        imageId: image.id,
        workKey: "photo",
        position: 3,
        state: "unresolved",
        skipReason: "Synthetic missing label",
        deviceWorkState: "failed",
        deviceWorkAttempts: 2,
      }),
    ]);
    expect(first.receipts).toEqual([
      expect.objectContaining({
        operationId: `migrated-target:${genericId}`,
        kind: "target_outcome",
        result: {
          target: expect.objectContaining({
            entityKind: "product",
            entityId: product.entityId,
            outcome: "enriched",
          }),
        },
      }),
    ]);
    await apply();
    expect(await read()).toEqual(first);
    await getDb(ctx.db).execute(sql`DROP TABLE "RunTarget"`);
    expect(await read()).toEqual(first);
    expect(
      (
        await getDb(ctx.db).execute(
          sql`SELECT to_regclass('"RunTarget"') AS retired`,
        )
      ).rows[0]?.retired,
    ).toBeNull();
  });
});
