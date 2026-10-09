import { acceptedResearchFact } from "@cubby/schemas/research";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  ledgerParty,
  entityExternalId,
  externalSource,
  product,
  runEvidence,
  runFactEvidence,
  runTarget,
} from "~/server/db/schema";
import { getDb, withTransaction } from "~/server/repo/database-helpers";
import {
  createProductFixture,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import {
  loadCurrentFactEvidence,
  recordAcceptedFactEvidence,
} from "./fact-verification";
import {
  loadProductResearchCoverage,
  readResearchCanonicalProjection,
} from "./research-projection";

// Database regressions: stale canonical data, foreign task/evidence, replay,
// accumulating support, deleted entity, and a source quote without identity reasoning.
describe("accepted research fact provenance", () => {
  const ctx = withTestDb();
  const support = {
    observation: "Example Works model Q-17",
    reasoning:
      "The model and manufacturer describe the selected ordered variant.",
    selectedVariant: {
      identity: "Q-17",
      attributes: { size: "small" },
      reasoning:
        "The order selected the small Q-17 rather than the larger Q-18.",
    },
  };

  async function fixture(name = "Example research product") {
    const entity = await createProductFixture(
      ctx.db,
      makeProductInput({
        name,
        manufacturer: "Example Works",
        model: "Q-17",
      }),
      ctx.actor,
    );
    const [existingParty] = await getDb(ctx.db)
      .select({ id: ledgerParty.id, shortcode: ledgerParty.shortcode })
      .from(ledgerParty)
      .where(eq(ledgerParty.userId, ctx.actor.userId));
    const party =
      existingParty ??
      (await insertWithShortcode(ctx.db, "ledgerParty", {
        name: "Example research member",
        kind: "member",
        userId: ctx.actor.userId,
      }));
    const run = await insertWithShortcode(ctx.db, "run", {
      purpose: "product_enrichment",
      trigger: "manual",
      ledgerPartyId: party.id,
      actorName: "Example research member",
      actorUserId: ctx.actor.userId,
      actorEmail: "research-member@example.test",
      actorLedgerPartyShortcode: party.shortcode,
      actorLedgerPartyName: "Example research member",
      actorLedgerPartyKind: "member",
    });
    const [target] = await getDb(ctx.db)
      .insert(runTarget)
      .values({
        runId: run.id,
        entityKind: "product",
        entityId: entity.entityId,
        targetFingerprint: "example-research-target",
      })
      .returning();
    if (!target) throw new Error("Expected research target");
    const evidence = async () => {
      const [row] = await getDb(ctx.db)
        .insert(runEvidence)
        .values({
          runId: run.id,
          targetId: target.id,
          kind: "browser_capture",
          objectKey: `synthetic-research/${crypto.randomUUID()}`,
          checksum: "a".repeat(64),
          mediaType: "text/html",
          sourceMetadata: { url: "https://shop.example.test/model-q17" },
        })
        .returning();
      if (!row) throw new Error("Expected research evidence");
      return row;
    };
    const first = await evidence();
    return {
      entity,
      run,
      target,
      evidence,
      claim: acceptedResearchFact.parse({
        evidenceId: first.id,
        fieldPath: "manufacturer",
        value: "Example Works",
        support,
      }),
    };
  }

  const proofs = (targetId: string) =>
    getDb(ctx.db)
      .select()
      .from(runFactEvidence)
      .where(eq(runFactEvidence.targetId, targetId));

  it("retains accepted source membership after rationale retirement while removing current proof coverage", async () => {
    const f = await fixture();
    await withTransaction(ctx.db, (tx) =>
      recordAcceptedFactEvidence(tx, {
        runId: f.run.id,
        targetId: f.target.id,
        claims: [f.claim],
      }),
    );
    const coverageInput = {
      productId: f.entity.entityId,
      ledgerPartyId: f.run.ledgerPartyId!,
    };
    expect(
      (await loadProductResearchCoverage(ctx.db, coverageInput)).verifiedFields,
    ).toContain("manufacturer");
    const retiredAt = new Date("2026-10-07T17:00:00.000Z");
    await getDb(ctx.db)
      .update(runFactEvidence)
      .set({ support: null, supportRetiredAt: retiredAt })
      .where(eq(runFactEvidence.targetId, f.target.id));
    const retained = await loadCurrentFactEvidence(ctx.db, {
      entityKind: "product",
      entityId: f.entity.id,
      fieldPath: "manufacturer",
      ledgerPartyId: coverageInput.ledgerPartyId,
    });
    expect(retained).toMatchObject([
      {
        value: "Example Works",
        support: null,
        supportRetiredAt: retiredAt.toISOString(),
        run: { entityKind: "run", entityId: f.run.shortcode },
        source: { url: "https://shop.example.test/model-q17" },
      },
    ]);
    const coverage = await loadProductResearchCoverage(ctx.db, coverageInput);
    expect(coverage.verifiedFields).not.toContain("manufacturer");
    expect(coverage.missingFields).toContain("manufacturer");
    expect(coverage.complete).toBe(false);
  });

  it("shows proof for a current owned identifier member and hides changed or removed members", async () => {
    const f = await fixture();
    await getDb(ctx.db)
      .insert(externalSource)
      .values({ slug: "example-shop", label: "Example shop" });
    const [member] = await getDb(ctx.db)
      .insert(entityExternalId)
      .values({
        entityKind: "product",
        entityId: f.entity.entityId,
        source: "example-shop",
        kind: "retailer_sku",
        externalId: "SMALL-17",
        isPrimary: true,
      })
      .returning();
    if (!member) throw new Error("Synthetic identifier missing");
    const path = `externalIds.i${member.id.replaceAll("-", "")}`;
    const value = {
      source: "example-shop",
      kind: "retailer_sku",
      externalId: "SMALL-17",
    };
    await withTransaction(ctx.db, (tx) =>
      recordAcceptedFactEvidence(
        tx,
        {
          runId: f.run.id,
          targetId: f.target.id,
          claims: [{ ...f.claim, fieldPath: path, value }],
        },
        readResearchCanonicalProjection,
      ),
    );
    const load = () =>
      loadCurrentFactEvidence(
        ctx.db,
        {
          entityKind: "product",
          entityId: f.entity.id,
          fieldPath: "externalIds",
        },
        readResearchCanonicalProjection,
      );
    expect(await load()).toMatchObject([{ fieldPath: path, value }]);
    await getDb(ctx.db)
      .update(entityExternalId)
      .set({ externalId: "LARGE-18" })
      .where(eq(entityExternalId.id, member.id));
    expect(await load()).toEqual([]);
    await getDb(ctx.db)
      .update(entityExternalId)
      .set({ externalId: "SMALL-17", deletedAt: new Date() })
      .where(eq(entityExternalId.id, member.id));
    expect(await load()).toEqual([]);
  });

  it("proves an already populated matching value, preserves variants, and replays once", async () => {
    const f = await fixture();
    const record = () =>
      withTransaction(ctx.db, (tx) =>
        recordAcceptedFactEvidence(tx, {
          runId: f.run.id,
          targetId: f.target.id,
          claims: [f.claim],
        }),
      );
    expect(await record()).toMatchObject({ inserted: 1 });
    expect(await record()).toMatchObject({ inserted: 0 });
    expect(await proofs(f.target.id)).toMatchObject([
      { value: "Example Works", support },
    ]);
    const [live] = await getDb(ctx.db)
      .select({ manufacturer: product.manufacturer })
      .from(product)
      .where(eq(product.id, f.entity.entityId));
    expect(live?.manufacturer).toBe("Example Works");
  });

  it("accumulates different observations for the same canonical field", async () => {
    const f = await fixture();
    const second = await f.evidence();
    await withTransaction(ctx.db, (tx) =>
      recordAcceptedFactEvidence(tx, {
        runId: f.run.id,
        targetId: f.target.id,
        claims: [
          f.claim,
          {
            ...f.claim,
            evidenceId: second.id,
            support: { ...support, observation: "Manufacturer: Example Works" },
          },
        ],
      }),
    );
    expect(await proofs(f.target.id)).toHaveLength(2);
  });
  it("shows current proof from retained mail with no public source URL", async () => {
    const f = await fixture();
    await getDb(ctx.db)
      .update(runEvidence)
      .set({
        kind: "mail_message",
        sourceMetadata: {
          sourceURL: null,
          title: "Retained synthetic confirmation",
        },
      })
      .where(eq(runEvidence.id, f.claim.evidenceId));
    await withTransaction(ctx.db, (tx) =>
      recordAcceptedFactEvidence(tx, {
        runId: f.run.id,
        targetId: f.target.id,
        claims: [f.claim],
      }),
    );
    expect(
      await loadCurrentFactEvidence(ctx.db, {
        entityKind: "product",
        entityId: f.entity.id,
        fieldPath: "manufacturer",
      }),
    ).toMatchObject([
      {
        value: "Example Works",
        source: { url: null, label: "Retained synthetic confirmation" },
      },
    ]);
  });

  it("refuses a stale value atomically even when another claim matches", async () => {
    const f = await fixture();
    await getDb(ctx.db)
      .update(product)
      .set({ model: "Q-18" })
      .where(eq(product.id, f.entity.entityId));
    await expect(
      withTransaction(ctx.db, (tx) =>
        recordAcceptedFactEvidence(tx, {
          runId: f.run.id,
          targetId: f.target.id,
          claims: [f.claim, { ...f.claim, fieldPath: "model", value: "Q-17" }],
        }),
      ),
    ).rejects.toThrow("canonical value");
    expect(await proofs(f.target.id)).toHaveLength(0);
  });

  it("rejects a foreign task, evidence from another task, and unbound evidence", async () => {
    const f = await fixture();
    const other = await fixture("Other example research product");
    await expect(
      withTransaction(ctx.db, (tx) =>
        recordAcceptedFactEvidence(tx, {
          runId: f.run.id,
          targetId: other.target.id,
          claims: [other.claim],
        }),
      ),
    ).rejects.toThrow("target");
    await expect(
      withTransaction(ctx.db, (tx) =>
        recordAcceptedFactEvidence(tx, {
          runId: f.run.id,
          targetId: f.target.id,
          claims: [{ ...f.claim, evidenceId: other.claim.evidenceId }],
        }),
      ),
    ).rejects.toThrow("evidence");
    await getDb(ctx.db)
      .update(runEvidence)
      .set({ runId: f.run.id })
      .where(eq(runEvidence.id, other.claim.evidenceId));
    await expect(
      withTransaction(ctx.db, (tx) =>
        recordAcceptedFactEvidence(tx, {
          runId: f.run.id,
          targetId: f.target.id,
          claims: [{ ...f.claim, evidenceId: other.claim.evidenceId }],
        }),
      ),
    ).rejects.toThrow("evidence");
    await getDb(ctx.db)
      .update(runEvidence)
      .set({ targetId: null })
      .where(eq(runEvidence.id, f.claim.evidenceId));
    await expect(
      withTransaction(ctx.db, (tx) =>
        recordAcceptedFactEvidence(tx, {
          runId: f.run.id,
          targetId: f.target.id,
          claims: [f.claim],
        }),
      ),
    ).rejects.toThrow("evidence");
    expect(await proofs(f.target.id)).toHaveLength(0);
  });

  it("refuses deleted entities and undeclared fields", async () => {
    const f = await fixture();
    await expect(
      withTransaction(ctx.db, (tx) =>
        recordAcceptedFactEvidence(tx, {
          runId: f.run.id,
          targetId: f.target.id,
          claims: [{ ...f.claim, fieldPath: "inventedField" }],
        }),
      ),
    ).rejects.toThrow("field");
    await getDb(ctx.db)
      .update(product)
      .set({ deletedAt: new Date() })
      .where(eq(product.id, f.entity.entityId));
    await expect(
      withTransaction(ctx.db, (tx) =>
        recordAcceptedFactEvidence(tx, {
          runId: f.run.id,
          targetId: f.target.id,
          claims: [f.claim],
        }),
      ),
    ).rejects.toThrow("live entity");
    expect(await proofs(f.target.id)).toHaveLength(0);
  });

  it("refuses quoted evidence without semantic reasoning", async () => {
    const f = await fixture();
    expect(
      acceptedResearchFact.safeParse({
        ...f.claim,
        support: { observation: support.observation },
      }).success,
    ).toBe(false);
    expect(await proofs(f.target.id)).toHaveLength(0);
  });

  it("retains canonical JSON null without treating it as SQL NULL", async () => {
    const f = await fixture();
    await getDb(ctx.db)
      .update(product)
      .set({ model: null })
      .where(eq(product.id, f.entity.entityId));
    await withTransaction(ctx.db, (tx) =>
      recordAcceptedFactEvidence(tx, {
        runId: f.run.id,
        targetId: f.target.id,
        claims: [
          {
            ...f.claim,
            fieldPath: "model",
            value: null,
            support: {
              observation:
                "No model identifier is listed for the selected generic product.",
              reasoning:
                "The source identifies this selected variant without a model identifier.",
            },
          },
        ],
      }),
    );
    expect(await proofs(f.target.id)).toMatchObject([
      { fieldPath: "model", value: null },
    ]);
  });

  it("loads proof only for the requested live subject and optional member scope", async () => {
    const f = await fixture();
    const other = await fixture("Other scoped research product");
    await withTransaction(ctx.db, (tx) =>
      recordAcceptedFactEvidence(tx, {
        runId: f.run.id,
        targetId: f.target.id,
        claims: [f.claim],
      }),
    );
    expect(
      await loadCurrentFactEvidence(ctx.db, {
        entityKind: "product",
        entityId: f.entity.id,
        fieldPath: "manufacturer",
        ledgerPartyId: f.run.ledgerPartyId!,
      }),
    ).toHaveLength(1);
    expect(
      await loadCurrentFactEvidence(ctx.db, {
        entityKind: "product",
        entityId: other.entity.id,
        fieldPath: "manufacturer",
      }),
    ).toEqual([]);
    const otherParty = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Other example member",
      kind: "member",
    });
    expect(
      await loadCurrentFactEvidence(ctx.db, {
        entityKind: "product",
        entityId: f.entity.id,
        fieldPath: "manufacturer",
        ledgerPartyId: otherParty.id,
      }),
    ).toEqual([]);
    await getDb(ctx.db)
      .update(product)
      .set({ deletedAt: new Date() })
      .where(eq(product.id, f.entity.entityId));
    expect(
      await loadCurrentFactEvidence(ctx.db, {
        entityKind: "product",
        entityId: f.entity.id,
        fieldPath: "manufacturer",
      }),
    ).toEqual([]);
  });
});
