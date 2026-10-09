import { initiateRunEvidenceUploadInput } from "@cubby/schemas/purchase-import";
import { sha256Hex } from "@cubby/shared/sha256";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { run, runEvidence, runTarget } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import {
  initiateRunEvidenceUpload,
  receiveRunEvidenceUpload,
} from "./run-evidence";

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
});
