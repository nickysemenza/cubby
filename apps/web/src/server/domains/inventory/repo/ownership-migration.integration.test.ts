import { readFileSync } from "node:fs";

import { parseEntityId } from "@cubby/schemas/identifiers";
import { sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { loadEffectiveInventoryOwnershipById } from "~/server/domains/inventory/repo/ownership";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import {
  createLocationFixture,
  createProductFixture,
  makeLocationInput,
  makeProductInput,
} from "~/server/testing/repo.fixtures";

/** The migration's statements, run against rows written in the old vocabulary. */
const inventoryOwnershipMigration = () =>
  readFileSync(
    new URL(
      "../../../../../drizzle/0067_inventory_ownership_explicit.sql",
      import.meta.url,
    ),
    "utf8",
  )
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);

// Household data must survive the move from person/unassigned to explicit:
// a named owner stays that owner, household stock stays household, and an
// inheriting entry keeps inheriting.
describe("inventory ownership vocabulary migration", () => {
  const ctx = withTestDb();
  it("keeps every entry's owner, household stock and inheritance", async () => {
    const product = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic migration jacket" }),
      ctx.actor,
    );
    const owner = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic migration owner",
      kind: "member",
    });
    const db = getDb(ctx.db);
    await db.execute(
      sql`ALTER TABLE "InventoryEntry" DROP CONSTRAINT "InventoryEntry_ownership_valid", DROP CONSTRAINT "InventoryEntry_ownershipMode_check"`,
    );
    const legacy = [
      { mode: "person", owner: owner.id },
      { mode: "unassigned", owner: null },
      { mode: "inherit", owner: null },
    ] as const;
    const ids: string[] = [];
    for (const [index, row] of legacy.entries()) {
      const place = await createLocationFixture(
        ctx.db,
        makeLocationInput({ name: `Synthetic migration shelf ${index}` }),
        ctx.actor,
      );
      const entry = await insertWithShortcode(ctx.db, "inventory", {
        productId: product.entityId,
        locationId: place.entityId,
        amountValue: 1,
        amountUnit: "each",
        ownershipMode: row.owner ? "explicit" : "inherit",
        ownerLedgerPartyId: row.owner,
      });
      ids.push(entry.id);
      await db.execute(
        sql`UPDATE "InventoryEntry" SET "ownershipMode" = ${row.mode} WHERE id = ${entry.id}::uuid`,
      );
    }
    // The pre-migration constraint, so the migration's own DROP applies.
    await db.execute(
      sql.raw(
        `ALTER TABLE "InventoryEntry" ADD CONSTRAINT "InventoryEntry_ownership_valid" CHECK (("ownershipMode" = 'person' AND "ownerLedgerPartyId" IS NOT NULL) OR ("ownershipMode" IN ('inherit', 'unassigned') AND "ownerLedgerPartyId" IS NULL)) NOT VALID`,
      ),
    );

    for (const statement of inventoryOwnershipMigration())
      if (!statement.includes('"PhotoGroupProposal"'))
        await db.execute(sql.raw(statement));

    const rows = await db.execute(
      sql`SELECT id, "ownershipMode", "ownerLedgerPartyId" FROM "InventoryEntry" WHERE id IN (${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`,
    );
    const byId = new Map(rows.rows.map((row) => [String(row.id), row]));
    expect(ids.map((id) => byId.get(id))).toMatchObject([
      { ownershipMode: "explicit", ownerLedgerPartyId: owner.id },
      { ownershipMode: "explicit", ownerLedgerPartyId: null },
      { ownershipMode: "inherit", ownerLedgerPartyId: null },
    ]);
    const effective = await Promise.all(
      ids.map((id) =>
        loadEffectiveInventoryOwnershipById(
          ctx.db,
          parseEntityId("inventory", id),
        ),
      ),
    );
    expect(effective.map((entry) => entry?.source)).toEqual([
      "explicit",
      "household",
      "unresolved",
    ]);
    expect(effective[0]?.effectiveOwner?.id).toBe(owner.shortcode);
  });
});
