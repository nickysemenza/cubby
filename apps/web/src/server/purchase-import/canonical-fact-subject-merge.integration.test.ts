import { parseEntityId } from "@cubby/schemas/identifiers";
import { acceptedResearchFact } from "@cubby/schemas/research";
import { sha256Hex } from "@cubby/shared/sha256";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  expense,
  image,
  ledgerParty,
  orderMail,
  purchase,
  runEvidence,
  runFactEvidence,
  runTarget,
} from "~/server/db/schema";
import { getDb, withTransaction } from "~/server/repo/database-helpers";
import { deleteImages } from "~/server/repo/image";
import { mergeProducts } from "~/server/repo/product/merge";
import { mergePurchases } from "~/server/repo/purchase";
import {
  createProductFixture,
  createImageFixture,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import {
  loadCurrentFactEvidence,
  recordAcceptedFactEvidence,
} from "./fact-verification";

// Canonical proof subjects must follow ordinary merges without losing task
// ownership, independent source support, or colliding on identical proof rows.
describe("canonical research fact subjects through entity merges", () => {
  const ctx = withTestDb();
  const support = (observation: string) => ({
    observation,
    reasoning:
      "The retained synthetic original supports this exact recorded value.",
  });

  async function researchRun(
    purpose: "product_enrichment" | "mail_import" | "photo_inventory",
  ) {
    const [existing] = await getDb(ctx.db)
      .select()
      .from(ledgerParty)
      .where(eq(ledgerParty.userId, ctx.actor.userId));
    const party =
      existing ??
      (await insertWithShortcode(ctx.db, "ledgerParty", {
        kind: "member",
        userId: ctx.actor.userId,
        name: "Synthetic proof owner",
      }));
    const row = await insertWithShortcode(ctx.db, "run", {
      purpose,
      trigger: "manual",
      status: "completed",
      endedAt: new Date("2026-10-01T12:00:00Z"),
      ledgerPartyId: party.id,
      actorUserId: ctx.actor.userId,
      actorName: party.name,
      actorEmail: "proof-owner@example.test",
      actorLedgerPartyShortcode: party.shortcode,
      actorLedgerPartyName: party.name,
      actorLedgerPartyKind: "member",
    });
    return { row, party };
  }

  async function target(
    scope: Awaited<ReturnType<typeof researchRun>>,
    subject: {
      entityKind: "product" | "run" | "image";
      entityId: string;
      workKey?: string;
    },
  ) {
    const [row] = await getDb(ctx.db)
      .insert(runTarget)
      .values({
        runId: scope.row.id,
        ...subject,
        state: "completed",
        outcome: "verified",
        targetFingerprint: "a".repeat(64),
      })
      .returning();
    if (!row) throw new Error("Synthetic proof task missing.");
    return row;
  }

  async function evidence(
    scope: Awaited<ReturnType<typeof researchRun>>,
    work: Awaited<ReturnType<typeof target>>,
    title: string,
    kind: "browser_capture" | "mail_message" = "browser_capture",
  ) {
    const [row] = await getDb(ctx.db)
      .insert(runEvidence)
      .values({
        runId: scope.row.id,
        targetId: work.id,
        kind,
        objectKey: `synthetic-proof-merge/${crypto.randomUUID()}`,
        checksum: await sha256Hex(title),
        mediaType: "text/plain",
        sourceMetadata: { sourceURL: null, title },
      })
      .returning();
    if (!row) throw new Error("Synthetic retained proof evidence missing.");
    return row;
  }

  it("removes an Image proof and task while preserving its retained original at the Run", async () => {
    const scope = await researchRun("photo_inventory");
    const subject = await createImageFixture(
      ctx.db,
      "synthetic-canonical-proof-image",
    );
    const work = await target(scope, {
      entityKind: "image",
      entityId: subject.id,
    });
    const original = await evidence(scope, work, "Synthetic image original");
    const [proof] = await getDb(ctx.db)
      .insert(runFactEvidence)
      .values({
        targetId: work.id,
        evidenceId: original.id,
        entityKind: "image",
        entityId: subject.id,
        fieldPath: "description",
        value: "Synthetic photographed object",
        valueFingerprint: await sha256Hex("Synthetic photographed object"),
        support: support(
          "The synthetic retained original describes the image.",
        ),
      })
      .returning();
    if (!proof) throw new Error("Synthetic image proof missing.");

    const result = await deleteImages(ctx.db, [
      parseEntityId("image", subject.id),
    ]);
    expect(result.deletedIds).toEqual([subject.id]);
    expect(
      await getDb(ctx.db)
        .select()
        .from(runFactEvidence)
        .where(eq(runFactEvidence.id, proof.id)),
    ).toEqual([]);
    expect(
      await getDb(ctx.db)
        .select()
        .from(runTarget)
        .where(eq(runTarget.id, work.id)),
    ).toEqual([]);
    expect(
      await getDb(ctx.db).select().from(image).where(eq(image.id, subject.id)),
    ).toEqual([]);
    expect(
      await getDb(ctx.db)
        .select()
        .from(runEvidence)
        .where(eq(runEvidence.id, original.id)),
    ).toEqual([{ ...original, targetId: null }]);
  });

  async function products() {
    const keeper = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "Synthetic keeper product",
        manufacturer: "Example Works",
      }),
      ctx.actor,
    );
    const loser = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "Synthetic duplicate product",
        manufacturer: "Example Works",
      }),
      ctx.actor,
    );
    return { keeper, loser };
  }

  it("repoints a Product task's unchanged canonical proof to the surviving Product", async () => {
    const { keeper, loser } = await products();
    const scope = await researchRun("product_enrichment");
    const work = await target(scope, {
      entityKind: "product",
      entityId: loser.entityId,
    });
    const original = await evidence(
      scope,
      work,
      "Synthetic Product manufacturer label",
    );
    const claim = acceptedResearchFact.parse({
      evidenceId: original.id,
      fieldPath: "manufacturer",
      value: "Example Works",
      support: support("Manufacturer: Example Works"),
    });
    await withTransaction(ctx.db, (tx) =>
      recordAcceptedFactEvidence(tx, {
        runId: scope.row.id,
        targetId: work.id,
        claims: [claim],
      }),
    );
    const before = await getDb(ctx.db).select().from(runFactEvidence);

    await mergeProducts(
      ctx.db,
      { keepId: keeper.id, mergeIds: [loser.id] },
      ctx.actor,
    );

    expect(await getDb(ctx.db).select().from(runFactEvidence)).toEqual(
      before.map((row) => ({ ...row, entityId: keeper.entityId })),
    );
    expect((await getDb(ctx.db).select().from(runTarget))[0]).toMatchObject({
      id: work.id,
      entityKind: "product",
      entityId: keeper.entityId,
    });
    expect(await getDb(ctx.db).select().from(runEvidence)).toEqual([original]);
    expect(
      await loadCurrentFactEvidence(ctx.db, {
        entityKind: "product",
        entityId: keeper.id,
        fieldPath: "manufacturer",
        ledgerPartyId: scope.party.id,
      }),
    ).toMatchObject([{ value: claim.value, support: claim.support }]);
    expect(
      await loadCurrentFactEvidence(ctx.db, {
        entityKind: "product",
        entityId: loser.id,
        fieldPath: "manufacturer",
        ledgerPartyId: scope.party.id,
      }),
    ).toEqual([]);
  });

  it("folds colliding Product tasks while preserving both independent retained proofs", async () => {
    const { keeper, loser } = await products();
    const scope = await researchRun("product_enrichment");
    const keeperWork = await target(scope, {
      entityKind: "product",
      entityId: keeper.entityId,
    });
    const loserWork = await target(scope, {
      entityKind: "product",
      entityId: loser.entityId,
    });
    const first = await evidence(scope, keeperWork, "Synthetic keeper label");
    const second = await evidence(
      scope,
      loserWork,
      "Synthetic duplicate label",
    );
    for (const [work, original, label] of [
      [keeperWork, first, "Synthetic keeper label"],
      [loserWork, second, "Synthetic duplicate label"],
    ] as const)
      await withTransaction(ctx.db, (tx) =>
        recordAcceptedFactEvidence(tx, {
          runId: scope.row.id,
          targetId: work.id,
          claims: [
            acceptedResearchFact.parse({
              evidenceId: original.id,
              fieldPath: "manufacturer",
              value: "Example Works",
              support: support(label),
            }),
          ],
        }),
      );
    const before = await getDb(ctx.db).select().from(runFactEvidence);

    await mergeProducts(
      ctx.db,
      { keepId: keeper.id, mergeIds: [loser.id] },
      ctx.actor,
    );

    const after = await getDb(ctx.db).select().from(runFactEvidence);
    expect(after).toHaveLength(2);
    expect(after.map((row) => row.id).sort()).toEqual(
      before.map((row) => row.id).sort(),
    );
    expect(after).toEqual(
      expect.arrayContaining(
        before.map((row) => ({
          ...row,
          targetId: keeperWork.id,
          entityId: keeper.entityId,
        })),
      ),
    );
    const tasks = await getDb(ctx.db).select().from(runTarget);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      id: keeperWork.id,
      runId: scope.row.id,
      entityKind: "product",
      entityId: keeper.entityId,
      state: keeperWork.state,
      targetFingerprint: keeperWork.targetFingerprint,
    });
    expect(await getDb(ctx.db).select().from(runEvidence)).toEqual(
      expect.arrayContaining([first, { ...second, targetId: keeperWork.id }]),
    );
    expect(
      await loadCurrentFactEvidence(ctx.db, {
        entityKind: "product",
        entityId: keeper.id,
        fieldPath: "manufacturer",
        ledgerPartyId: scope.party.id,
      }),
    ).toHaveLength(2);
  });

  it("keeps distinct source work keys when Product tasks converge on one merged subject", async () => {
    const { keeper, loser } = await products();
    const scope = await researchRun("product_enrichment");
    const keeperWork = await target(scope, {
      entityKind: "product",
      entityId: keeper.entityId,
      workKey: "synthetic-original-a",
    });
    const loserWork = await target(scope, {
      entityKind: "product",
      entityId: loser.entityId,
      workKey: "synthetic-original-b",
    });
    const first = await evidence(
      scope,
      keeperWork,
      "Synthetic first source task",
    );
    const second = await evidence(
      scope,
      loserWork,
      "Synthetic second source task",
    );

    await mergeProducts(
      ctx.db,
      { keepId: keeper.id, mergeIds: [loser.id] },
      ctx.actor,
    );

    const tasks = await getDb(ctx.db).select().from(runTarget);
    expect(tasks).toHaveLength(2);
    expect(tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: keeperWork.id,
          runId: scope.row.id,
          entityKind: "product",
          entityId: keeper.entityId,
          workKey: keeperWork.workKey,
        }),
        expect.objectContaining({
          id: loserWork.id,
          runId: scope.row.id,
          entityKind: "product",
          entityId: keeper.entityId,
          workKey: loserWork.workKey,
        }),
      ]),
    );
    expect(await getDb(ctx.db).select().from(runEvidence)).toEqual(
      expect.arrayContaining([first, second]),
    );
  });

  it("repoints Run-origin Purchase proofs and folds exact duplicates without discarding independent support", async () => {
    const scope = await researchRun("mail_import");
    const merchant = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic proof merchant",
    });
    const category = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Synthetic service category",
    });
    const keeper = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: merchant.id,
      date: "2026-10-01",
      spendingCategoryId: category.id,
    });
    const loser = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: merchant.id,
      date: "2026-10-01",
      spendingCategoryId: category.id,
    });
    const [mail] = await getDb(ctx.db)
      .insert(orderMail)
      .values({
        ledgerPartyId: scope.party.id,
        mailboxId: "synthetic-proof-mailbox",
        messageId: "synthetic-proof-message",
        sender: "receipts@example.test",
        subject: "Synthetic service receipts",
        receivedAt: new Date("2026-10-01T12:00:00Z"),
        rawChecksum: await sha256Hex("Synthetic service receipts"),
        content: {
          snippet: null,
          bodyText: "Synthetic service receipts",
          bodyHtml: null,
        },
      })
      .returning();
    if (!mail) throw new Error("Synthetic original mail missing.");
    const work = await target(scope, {
      entityKind: "run",
      entityId: scope.row.id,
      workKey: mail.id,
    });
    const first = await evidence(
      scope,
      work,
      "Synthetic original category",
      "mail_message",
    );
    const second = await evidence(
      scope,
      work,
      "Synthetic independent category",
      "mail_message",
    );
    const record = (entityId: string, original: typeof first) =>
      withTransaction(ctx.db, (tx) =>
        recordAcceptedFactEvidence(tx, {
          runId: scope.row.id,
          targetId: work.id,
          subject: { entityKind: "purchase", entityId },
          claims: [
            acceptedResearchFact.parse({
              evidenceId: original.id,
              fieldPath: "spendingCategoryId",
              value: category.id,
              support: support(
                original.id === first.id
                  ? "Synthetic original category"
                  : "Synthetic independent category",
              ),
            }),
          ],
        }),
      );
    await record(keeper.id, first);
    await record(loser.id, first);
    await record(loser.id, second);
    const before = await getDb(ctx.db).select().from(runFactEvidence);
    const canonical = before.find((row) => row.entityId === keeper.id);
    const independent = before.find((row) => row.evidenceId === second.id);
    if (!canonical || !independent)
      throw new Error("Synthetic proof rows missing.");
    const money = await getDb(ctx.db).select().from(expense);

    await mergePurchases(
      ctx.db,
      { keepId: keeper.shortcode, mergeIds: [loser.shortcode] },
      ctx.actor,
    );

    expect(await getDb(ctx.db).select().from(runFactEvidence)).toEqual(
      expect.arrayContaining([
        canonical,
        { ...independent, entityId: keeper.id },
      ]),
    );
    expect(await getDb(ctx.db).select().from(runFactEvidence)).toHaveLength(2);
    expect(await getDb(ctx.db).select().from(runTarget)).toEqual([work]);
    expect(await getDb(ctx.db).select().from(runEvidence)).toEqual(
      expect.arrayContaining([first, second]),
    );
    expect(await getDb(ctx.db).select().from(orderMail)).toEqual([mail]);
    expect(await getDb(ctx.db).select().from(expense)).toEqual(money);
    expect(
      (
        await getDb(ctx.db)
          .select()
          .from(purchase)
          .where(eq(purchase.id, keeper.id))
      )[0]?.spendingCategoryId,
    ).toBe(category.id);
    const current = await loadCurrentFactEvidence(ctx.db, {
      entityKind: "purchase",
      entityId: keeper.shortcode,
      fieldPath: "spendingCategoryId",
      ledgerPartyId: scope.party.id,
    });
    expect(current).toHaveLength(2);
    expect(current.map((row) => row.support?.observation).sort()).toEqual([
      "Synthetic independent category",
      "Synthetic original category",
    ]);
    expect(
      await loadCurrentFactEvidence(ctx.db, {
        entityKind: "purchase",
        entityId: loser.shortcode,
        fieldPath: "spendingCategoryId",
        ledgerPartyId: scope.party.id,
      }),
    ).toEqual([]);
  });
});
