import { parseEntityId } from "@cubby/schemas/identifiers";
import { testUserId } from "@cubby/schemas/testing";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { importFinding, user } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import {
  createInventoryFixture,
  createLocationFixture,
  createProductFixture,
  makeLocationInput,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { findOrCreateVendor } from "~/server/repo/vendor";

import { resolveArrivedFindingsForPurchase } from "./findings";

describe("resolveArrivedFindingsForPurchase", () => {
  const ctx = withTestDb();

  /** Mirrors the "arrived" finding `writer.ts` files once every shipment is delivered. */
  const fileArrivedFinding = async (
    ledgerPartyId: string,
    purchaseId: string,
    fingerprint: string,
  ) => {
    const [row] = await getDb(ctx.db)
      .insert(importFinding)
      .values({
        ledgerPartyId: parseEntityId("ledgerParty", ledgerPartyId),
        targetType: "purchase",
        targetId: purchaseId,
        kind: "arrived",
        summary:
          "All shipments are marked delivered. Review and receive this purchase.",
        proposedFix: { kind: "receive_purchase", purchaseId },
        evidenceFingerprint: fingerprint,
      })
      .returning({ id: importFinding.id });
    if (!row) throw new Error("test setup: finding not inserted");
    return row.id;
  };

  const readFinding = async (id: string) => {
    const [row] = await getDb(ctx.db)
      .select({
        status: importFinding.status,
        resolvedByUserId: importFinding.resolvedByUserId,
        resolvedAt: importFinding.resolvedAt,
      })
      .from(importFinding)
      .where(eq(importFinding.id, id));
    if (!row) throw new Error(`test assertion: finding ${id} not found`);
    return row;
  };

  it("resolves an arrived finding only once every product line is received, and leaves another member's finding alone", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Findings Test Buyer",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendorId = await findOrCreateVendor(ctx.db, "Findings Test Vendor");
    const purchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId,
      date: "2026-01-01",
      displayLabel: "Two-line delivered order",
    });
    const [productA, productB] = await Promise.all([
      createProductFixture(
        ctx.db,
        makeProductInput({ name: "Arrived Finding Product A" }),
        ctx.actor,
      ),
      createProductFixture(
        ctx.db,
        makeProductInput({ name: "Arrived Finding Product B" }),
        ctx.actor,
      ),
    ]);
    await Promise.all([
      insertWithShortcode(ctx.db, "expense", {
        name: "Line A",
        cost: 10,
        date: "2026-01-01",
        costType: "materials",
        productId: productA.entityId,
        purchaseId: purchase.id,
      }),
      insertWithShortcode(ctx.db, "expense", {
        name: "Line B",
        cost: 20,
        date: "2026-01-01",
        costType: "materials",
        productId: productB.entityId,
        purchaseId: purchase.id,
      }),
    ]);

    const findingId = await fileArrivedFinding(
      party.id,
      purchase.id,
      "own-finding",
    );

    // Another member's own finding on the same purchase must never be
    // touched by resolving this actor's finding — scoped by ledgerParty
    // ownership, mirroring `resolveImportFinding`.
    const otherUserId = testUserId("findings-other-member");
    await getDb(ctx.db).insert(user).values({
      id: otherUserId,
      name: "Other Household Member",
      email: "other-findings-member@example.com",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const otherParty = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Other Findings Member",
      kind: "member",
      userId: otherUserId,
    });
    const otherFindingId = await fileArrivedFinding(
      otherParty.id,
      purchase.id,
      "other-finding",
    );

    // Neither product line is received yet: nothing resolves.
    await expect(
      resolveArrivedFindingsForPurchase(
        ctx.db,
        { purchaseId: purchase.id },
        ctx.actor,
      ),
    ).resolves.toEqual({ resolved: 0 });
    expect((await readFinding(findingId)).status).toBe("open");

    const location = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Findings Test Shelf" }),
      ctx.actor,
    );

    // Receive line A only: the purchase is still partially outstanding, so
    // the finding must stay open.
    await createInventoryFixture(
      ctx.db,
      {
        productId: productA.id,
        locationId: location.id,
        amount: { value: 1, unit: "each" },
      },
      ctx.actor,
    );
    await expect(
      resolveArrivedFindingsForPurchase(
        ctx.db,
        { purchaseId: purchase.id },
        ctx.actor,
      ),
    ).resolves.toEqual({ resolved: 0 });
    expect((await readFinding(findingId)).status).toBe("open");

    // Receive line B: every product-bearing line now has inventory, so the
    // finding resolves.
    await createInventoryFixture(
      ctx.db,
      {
        productId: productB.id,
        locationId: location.id,
        amount: { value: 1, unit: "each" },
      },
      ctx.actor,
    );
    await expect(
      resolveArrivedFindingsForPurchase(
        ctx.db,
        { purchaseId: purchase.id },
        ctx.actor,
      ),
    ).resolves.toEqual({ resolved: 1 });

    const resolved = await readFinding(findingId);
    expect(resolved.status).toBe("applied");
    expect(resolved.resolvedByUserId).toBe(ctx.actor.userId);
    expect(resolved.resolvedAt).not.toBeNull();

    // The other member's finding on the same purchase was never in scope.
    expect((await readFinding(otherFindingId)).status).toBe("open");
  });
});
