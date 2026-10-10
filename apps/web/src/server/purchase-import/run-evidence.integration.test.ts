import { initiateRunEvidenceUploadInput } from "@cubby/schemas/purchase-import";
import { sha256Hex } from "@cubby/shared/sha256";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  run,
  runEvidence,
  runTarget,
  runFactEvidence,
} from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import {
  createProductFixture,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import {
  initiateRunEvidenceUpload,
  receiveRunEvidenceUpload,
  readRunEvidenceMedia,
} from "./run-evidence";
import { loadRunDetail } from "./run-service";

// A durable retirement marker fences storage even when an older status or
// delayed browser command still describes the target as writable.
describe("run-scoped evidence upload admission", () => {
  const ctx = withTestDb();
  async function fixture() {
    const member = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic upload member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const owner = await insertWithShortcode(ctx.db, "run", {
      purpose: "product_enrichment",
      status: "running",
      trigger: "manual",
      ledgerPartyId: member.id,
      actorUserId: ctx.actor.userId,
      actorName: member.name,
      actorEmail: "upload@example.test",
      actorLedgerPartyShortcode: member.shortcode,
      actorLedgerPartyName: member.name,
      actorLedgerPartyKind: "member",
      input: null,
    });
    const [target] = await getDb(ctx.db)
      .insert(runTarget)
      .values({
        runId: owner.id,
        entityId: owner.id,
        entityKind: "run",
        workKey: "synthetic-upload-work",
        state: "pending",
        targetFingerprint: "synthetic-upload-source",
      })
      .returning();
    if (!target) throw new Error("Synthetic upload work missing");
    const input = initiateRunEvidenceUploadInput.parse({
      runId: owner.shortcode,
      targetId: target.id,
      kind: "browser_capture",
      filename: "synthetic.pdf",
      contentType: "application/pdf",
      byteSize: 4,
      checksum: await sha256Hex("test"),
    });
    return { owner, input };
  }
  it("refuses a retired coordinator before allocating upload metadata or a write capability", async () => {
    const { owner, input } = await fixture();
    await getDb(ctx.db)
      .update(run)
      .set({
        retiredAt: new Date(),
        retirementReason: "unrelated_source",
      })
      .where(eq(run.id, owner.id));
    await expect(
      initiateRunEvidenceUpload(ctx.db, input, ctx.actor.userId),
    ).rejects.toThrow(/retired|not writable/i);
    expect(
      await getDb(ctx.db)
        .select()
        .from(runEvidence)
        .where(eq(runEvidence.runId, owner.id)),
    ).toEqual([]);
  });
  it("stores verified bytes and refuses replay of the same upload URL after retirement", async () => {
    const { owner, input } = await fixture();
    const staged = await initiateRunEvidenceUpload(
      ctx.db,
      input,
      ctx.actor.userId,
    );
    const stored = new Map<string, Uint8Array>();
    const storage = {
      put: async (key: string, bytes: Uint8Array) => {
        stored.set(key, bytes);
      },
    };
    const request = () =>
      new Request(staged.uploadUrl, {
        method: "PUT",
        headers: { "content-type": input.contentType },
        body: "test",
      });
    expect(
      (await receiveRunEvidenceUpload(ctx.db, request(), storage)).status,
    ).toBe(204);
    expect(new TextDecoder().decode(stored.get(staged.objectKey))).toBe("test");
    await getDb(ctx.db)
      .update(run)
      .set({
        retiredAt: new Date(),
        retirementReason: "unrelated_source",
      })
      .where(eq(run.id, owner.id));
    stored.clear();
    expect(
      (await receiveRunEvidenceUpload(ctx.db, request(), storage)).status,
    ).toBe(409);
    expect(stored.size).toBe(0);
  });
  it("refuses checksum-mismatched bytes while preserving the allocated storage manifest", async () => {
    const { owner, input } = await fixture();
    const staged = await initiateRunEvidenceUpload(
      ctx.db,
      input,
      ctx.actor.userId,
    );
    const stored = new Map<string, Uint8Array>();
    const response = await receiveRunEvidenceUpload(
      ctx.db,
      new Request(staged.uploadUrl, {
        method: "PUT",
        headers: { "content-type": input.contentType },
        body: "oops",
      }),
      {
        put: async (key, bytes) => {
          stored.set(key, bytes);
        },
      },
    );
    expect(response.status).toBe(422);
    expect(stored.size).toBe(0);
    const [manifest] = await getDb(ctx.db)
      .select()
      .from(runEvidence)
      .where(eq(runEvidence.runId, owner.id));
    expect(manifest?.objectKey).toBe(staged.objectKey);
    expect(manifest?.checksum).toBe(input.checksum);
  });
  it("delivers retained media only for its owned Run and target, including completed work", async () => {
    const { owner, input } = await fixture();
    const staged = await initiateRunEvidenceUpload(
      ctx.db,
      input,
      ctx.actor.userId,
    );
    await getDb(ctx.db)
      .update(run)
      .set({ status: "completed" })
      .where(eq(run.id, owner.id));
    const selection = {
      runId: owner.shortcode,
      targetId: input.targetId,
      evidenceId: staged.evidenceId,
    };
    const reads: string[] = [];
    const storage = async (key: string) => {
      reads.push(key);
      return new Response("test", {
        headers: { "content-type": "application/pdf" },
      });
    };
    const response = await readRunEvidenceMedia(
      ctx.db,
      selection,
      ctx.actor.userId,
      storage,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("test");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(reads).toEqual([staged.objectKey]);
    reads.length = 0;
    const mismatched = await readRunEvidenceMedia(
      ctx.db,
      { ...selection, targetId: crypto.randomUUID() },
      ctx.actor.userId,
      storage,
    );
    expect(mismatched.status).toBe(404);
    expect(reads).toEqual([]);
    expect(
      (
        await readRunEvidenceMedia(
          ctx.db,
          selection,
          crypto.randomUUID(),
          storage,
        )
      ).status,
    ).toBe(404);
    expect(reads).toEqual([]);
  });
  it("refuses corrupt retained media and retirement without delivering source bytes", async () => {
    const { owner, input } = await fixture();
    const staged = await initiateRunEvidenceUpload(
      ctx.db,
      input,
      ctx.actor.userId,
    );
    const selection = {
      runId: owner.shortcode,
      targetId: input.targetId,
      evidenceId: staged.evidenceId,
    };
    const corrupted = await readRunEvidenceMedia(
      ctx.db,
      selection,
      ctx.actor.userId,
      async () => new Response("oops"),
    );
    expect(corrupted.status).toBe(422);
    expect(await corrupted.text()).not.toContain("oops");
    await getDb(ctx.db)
      .update(run)
      .set({ retiredAt: new Date(), retirementReason: "unrelated_source" })
      .where(eq(run.id, owner.id));
    let fetched = false;
    const retired = await readRunEvidenceMedia(
      ctx.db,
      selection,
      ctx.actor.userId,
      async () => {
        fetched = true;
        return new Response("test");
      },
    );
    expect(retired.status).toBe(404);
    expect(fetched).toBe(false);
  });
  it("projects retained capture context with an owned media path without exposing object keys", async () => {
    const { owner, input } = await fixture();
    const staged = await initiateRunEvidenceUpload(
      ctx.db,
      {
        ...input,
        sourceMetadata: {
          sourceURL: "https://shop.example.test/orders/confirmation",
          title: "Synthetic order confirmation",
          capturedAt: "2026-09-01T18:00:00.000Z",
        },
      },
      ctx.actor.userId,
    );
    const detail = await loadRunDetail(ctx.db, owner.shortcode);
    const evidence = detail.evidence.find(
      (item) => item.id === staged.evidenceId,
    );
    expect(evidence).toMatchObject({
      title: "Synthetic order confirmation",
      sourceURL: "https://shop.example.test/orders/confirmation",
      capturedAt: "2026-09-01T18:00:00.000Z",
    });
    const mediaUrl = new URL(
      evidence?.mediaUrl ?? "",
      "https://cubby.example.test",
    );
    expect(mediaUrl.pathname).toBe("/api/import/evidence");
    expect(mediaUrl.searchParams.get("runId")).toBe(owner.shortcode);
    expect(mediaUrl.searchParams.get("targetId")).toBe(input.targetId);
    expect(mediaUrl.searchParams.get("evidenceId")).toBe(staged.evidenceId);
    expect(JSON.stringify(detail.evidence)).not.toContain(staged.objectKey);
  });
  it("associates only live accepted facts with the exact retained source and target", async () => {
    const { owner, input } = await fixture();
    const subject = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic supported Product" }),
      ctx.actor,
    );
    const staged = await initiateRunEvidenceUpload(
      ctx.db,
      input,
      ctx.actor.userId,
    );
    const [other] = await getDb(ctx.db)
      .insert(runTarget)
      .values({
        runId: owner.id,
        entityId: owner.id,
        entityKind: "run",
        workKey: "other-source-target",
        state: "pending",
        targetFingerprint: "other-source-target",
      })
      .returning();
    if (!other) throw new Error("Synthetic second target missing");
    await getDb(ctx.db)
      .insert(runFactEvidence)
      .values([
        {
          targetId: input.targetId,
          evidenceId: staged.evidenceId,
          entityKind: "product",
          entityId: subject.entityId,
          fieldPath: "model",
          value: "SYNTHETIC-1",
          support: {
            observation: "Model SYNTHETIC-1",
            reasoning: "Synthetic selected item identifies this model.",
          },
          valueFingerprint: await sha256Hex('"SYNTHETIC-1"'),
        },
        {
          targetId: input.targetId,
          evidenceId: staged.evidenceId,
          entityKind: "product",
          entityId: subject.entityId,
          fieldPath: "manufacturer",
          value: "Retired support",
          valueFingerprint: await sha256Hex('"Retired support"'),
          supportRetiredAt: new Date(),
        },
        {
          targetId: other.id,
          evidenceId: staged.evidenceId,
          entityKind: "product",
          entityId: subject.entityId,
          fieldPath: "description",
          value: "Foreign target",
          support: {
            observation: "Other target text",
            reasoning: "Synthetic other task support.",
          },
          valueFingerprint: await sha256Hex('"Foreign target"'),
        },
      ]);
    const detail = await loadRunDetail(ctx.db, owner.shortcode);
    expect(
      detail.evidence.find((item) => item.id === staged.evidenceId)
        ?.supportedFacts,
    ).toEqual([
      {
        entityKind: "product",
        entityShortcode: subject.id,
        fieldPath: "model",
        value: "SYNTHETIC-1",
      },
    ]);
    expect(JSON.stringify(detail.evidence)).not.toContain("Foreign target");
    expect(JSON.stringify(detail.evidence)).not.toContain("Retired support");
  });

  it("resolves a page screenshot only through matching retained target, hash and media", async () => {
    const { owner, input } = await fixture();
    const screenshot = await initiateRunEvidenceUpload(
      ctx.db,
      { ...input, contentType: "image/png", filename: "viewport.png" },
      ctx.actor.userId,
    );
    const [page] = await getDb(ctx.db)
      .insert(runEvidence)
      .values({
        runId: owner.id,
        targetId: input.targetId,
        kind: "browser_capture",
        objectKey: `synthetic-page-${crypto.randomUUID()}`,
        checksum: input.checksum,
        byteSize: input.byteSize,
        mediaType: "text/html",
        sourceMetadata: {
          title: "Synthetic captured page",
          sourceURL: "https://shop.example.test/item",
          screenshots: [
            {
              id: screenshot.evidenceId,
              kind: "screenshot",
              checksum: "0".repeat(64),
              contentType: "image/png",
            },
            {
              id: screenshot.evidenceId,
              kind: "screenshot",
              checksum: input.checksum,
              contentType: "image/png",
            },
          ],
        },
      })
      .returning();
    if (!page) throw new Error("Synthetic captured page missing");
    const readPage = async () =>
      (await loadRunDetail(ctx.db, owner.shortcode)).evidence.find(
        (item) => item.id === page.id,
      );
    const retained = await readPage();
    const preview = new URL(
      retained?.previewUrl ?? "",
      "https://cubby.example.test",
    );
    expect(preview.searchParams.get("evidenceId")).toBe(screenshot.evidenceId);
    await getDb(ctx.db)
      .update(runEvidence)
      .set({ checksum: "1".repeat(64) })
      .where(eq(runEvidence.id, screenshot.evidenceId));
    expect((await readPage())?.previewUrl).toBeUndefined();
    const [other] = await getDb(ctx.db)
      .insert(runTarget)
      .values({
        runId: owner.id,
        entityId: owner.id,
        entityKind: "run",
        workKey: "unrelated-screenshot",
        state: "pending",
        targetFingerprint: "unrelated-screenshot",
      })
      .returning();
    if (!other) throw new Error("Synthetic unrelated target missing");
    await getDb(ctx.db)
      .update(runEvidence)
      .set({ checksum: input.checksum, targetId: other.id })
      .where(eq(runEvidence.id, screenshot.evidenceId));
    expect((await readPage())?.previewUrl).toBeUndefined();
  });
});
