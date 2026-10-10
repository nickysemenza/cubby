import { userId } from "@cubby/schemas/identifiers";
import { productResearchRunInput } from "@cubby/schemas/run-fields";
import { eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { run, runEvidence, runTarget, user } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { withTransactionDatabase } from "~/server/repo/database-helpers";
import {
  createProductFixture,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import {
  insertOperation,
  readOperation,
  setOperationResult,
} from "~/server/repo/run-operation";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { ensureRun } from "~/server/runs/ensure-run";

import { resolveResearchBrowserOperation } from "./agent-browser-command";
import { derivePageCapture, encodeSnapshotDom } from "./browser-page";
import { materializeCapture } from "./browser-results";
import { rederiveRetainedCapture } from "./capture-maintenance";
import { productEnrichmentTarget } from "./product-enrichment-target";
import { loadResearchEvidence } from "./research-evidence";
import {
  retainResearchObservation,
  webReadResearch,
  webSearchResearch,
} from "./research-observations";
import { loadRunLog } from "./run-service";

// Evidence must not drift to another target or overwrite a completed call.
// A selected variant without JSON-LD remains readable; candidates never prove
// acceptance. Search snippets cannot become retained factual page evidence.
// A failed database insert or partial PUT must not leave an untracked object;
// pending manifests cannot supply facts and must replay the same bytes/key.
describe("retained research observations", () => {
  const ctx = withTestDb();
  async function scope() {
    await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Research observation member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const runId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "product_enrichment",
      trigger: "manual",
      status: "running",
    });
    const targets = await Promise.all(
      ["First", "Second"].map(async (name) => {
        const product = await createProductFixture(
          ctx.db,
          makeProductInput({
            name: `${name} synthetic shirt`,
            manufacturer: "Synthetic maker",
          }),
          ctx.actor,
        );
        const context = await productEnrichmentTarget(
          getDb(ctx.db),
          product.entityId,
        );
        if (!context) throw new Error("Synthetic Product context missing");
        const [target] = await getDb(ctx.db)
          .insert(runTarget)
          .values({
            runId,
            entityKind: "product",
            entityId: product.entityId,
            workKey: product.entityId,
            targetFingerprint: context.fingerprint,
          })
          .returning();
        if (!target)
          throw new Error("Synthetic research target did not persist");
        return target;
      }),
    );
    const [first, second] = targets;
    if (!first || !second)
      throw new Error("Synthetic target set is incomplete");
    await getDb(ctx.db)
      .update(run)
      .set({
        input: productResearchRunInput.parse({
          kind: "product_research",
          instructionRevision: 1,
          products: targets.map((target) => ({
            productId: target.entityId,
            contextFingerprint: target.targetFingerprint,
          })),
        }),
      })
      .where(eq(run.id, runId));
    const objects = new Map<string, Uint8Array>();
    const storage = {
      put: async (key: string, bytes: Uint8Array) => {
        objects.set(key, new Uint8Array(bytes));
      },
    };
    const [runRow] = await getDb(ctx.db)
      .select({ shortcode: run.shortcode })
      .from(run)
      .where(eq(run.id, runId));
    if (!runRow) throw new Error("Synthetic research Run did not persist");
    return {
      runId,
      shortcode: runRow.shortcode,
      first,
      second,
      objects,
      ports: { storage },
    };
  }
  const sourceMetadata = {
    sourceURL: "https://shop.example.test/shirt",
    servedURL: "https://shop.example.test/shirt?variant=green",
    title: "Synthetic shirt",
    capturedAt: "2026-10-07T12:00:00Z",
  };

  // Maintenance must work after settlement, reject substituted originals, and
  // append a versioned receipt without changing the original command replay.
  it("re-derives settled retained captures without rewriting original receipts", async () => {
    const s = await scope();
    const html = "<p>Retained selected green shirt</p>";
    const research = await retainResearchObservation(
      ctx.db,
      {
        runId: s.runId,
        workRef: s.first.id,
        callId: crypto.randomUUID(),
        kind: "browser_capture",
        sourceMetadata,
        content: html,
      },
      s.ports,
    );
    const operationId = "synthetic-capture";
    const commandId = crypto.randomUUID();
    const capture = derivePageCapture({
      html,
      sourceURL: sourceMetadata.servedURL,
      title: sourceMetadata.title,
      capturedAt: sourceMetadata.capturedAt,
      allowedHosts: ["shop.example.test"],
      requestedURL: sourceMetadata.sourceURL,
      evidence: [],
      truncated: false,
    });
    const original = {
      commandId,
      workRef: s.first.id,
      command: {
        protocolVersion: 4,
        id: commandId,
        operationId,
        runID: s.runId,
        deadline: "2026-10-07T12:05:00Z",
        operation: {
          type: "navigate",
          url: sourceMetadata.sourceURL,
          allowedHosts: ["shop.example.test"],
        },
      },
      page: {
        capture: { ...capture, captureVersion: 1 },
        domEvidenceId: research.evidenceId,
        research,
        observation: {
          url: sourceMetadata.servedURL,
          title: sourceMetadata.title,
          readyState: "complete",
          window: null,
          screenRecording: "granted",
          durationMs: 1,
        },
      },
    };
    await insertOperation(getDb(ctx.db), {
      runId: s.runId,
      operationId,
      kind: "browser_command",
      inputFingerprint: "synthetic",
      state: "completed",
      result: original,
    });
    await getDb(ctx.db)
      .update(runTarget)
      .set({ state: "completed" })
      .where(eq(runTarget.id, s.first.id));
    await getDb(ctx.db)
      .update(run)
      .set({ status: "completed" })
      .where(eq(run.id, s.runId));
    const input = { actor: ctx.actor, key: { runId: s.runId, operationId } };
    await expect(
      rederiveRetainedCapture(ctx.db, input, async () => "substituted bytes"),
    ).rejects.toThrow(/checksum/u);
    const result = await rederiveRetainedCapture(
      ctx.db,
      input,
      async () => html,
    );
    expect(result.capture.readableText).toContain(
      "Retained selected green shirt",
    );
    expect(result.capture.captureVersion).toBeGreaterThan(1);
    expect(result.evidenceId).toBe(research.evidenceId);
    expect((await loadRunLog(ctx.db, s.shortcode)).entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "capture.reinterpreted",
          state: "completed",
        }),
      ]),
    );
    expect(
      await rederiveRetainedCapture(ctx.db, input, async () => html),
    ).toEqual(result);
    expect((await readOperation(getDb(ctx.db), input.key))?.result).toEqual(
      original,
    );
    expect(
      (
        await getDb(ctx.db)
          .select()
          .from(runTarget)
          .where(eq(runTarget.id, s.first.id))
      )[0]?.state,
    ).toBe("completed");
  });

  it("reads receipt facts after oversized mail styles without changing retained originals", async () => {
    const s = await scope();
    const bodyHtml = `<html><head><style>/*${"synthetic layout padding ".repeat(2_000)}*/</style></head><body><p>Order SYNTHETIC-410. Green shirt, size M. Total USD 24.00.</p><a href="https://shop.example.test/orders/synthetic-410">Order details</a></body></html>`;
    for (const [index, bodyText] of [
      null,
      "Plain-text receipt: shipping on September 15.",
    ].entries()) {
      const content = JSON.stringify({
        sender: "orders@shop.example.test",
        subject: "Synthetic order confirmation",
        content: {
          headers: {},
          snippet: null,
          bodyHtml,
          bodyText,
        },
      });
      const input = {
        runId: s.runId,
        workRef: s.first.id,
        callId: `read:mail-layout-${index}`,
        kind: "mail_message" as const,
        sourceMetadata: { sourceURL: null },
        content,
      };
      const result = await retainResearchObservation(ctx.db, input, s.ports);
      expect(result.observation.readableText).toContain("Green shirt, size M");
      expect(result.observation.readableText).toContain("Total USD 24.00");
      expect(result.observation.readableText).toContain(
        "https://shop.example.test/orders/synthetic-410",
      );
      expect(JSON.parse(result.observation.readableText)).toMatchObject({
        content: { bodyText },
      });
      expect(result.observation.textTruncated).toBe(false);
      expect(result.observation.readableText).not.toContain(
        "synthetic layout padding",
      );
      const original = [...s.objects.values()].find(
        (bytes) => new TextDecoder().decode(bytes) === content,
      );
      expect(original).toBeDefined();
      expect(await retainResearchObservation(ctx.db, input, s.ports)).toEqual(
        result,
      );
    }
  });

  it("does not upload bytes before a durable manifest insert rejected by PostgreSQL", async () => {
    const s = await scope();
    await getDb(ctx.db).execute(sql`
      CREATE FUNCTION synthetic_reject_evidence_manifest() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        RAISE EXCEPTION 'Synthetic evidence manifest unavailable';
      END $$
    `);
    await getDb(ctx.db).execute(sql`
      CREATE TRIGGER synthetic_reject_evidence_manifest
      BEFORE INSERT ON "RunEvidence" FOR EACH ROW
      EXECUTE FUNCTION synthetic_reject_evidence_manifest()
    `);
    try {
      await expect(
        retainResearchObservation(
          ctx.db,
          {
            runId: s.runId,
            workRef: s.first.id,
            callId: "read:database-failure",
            kind: "web_page",
            sourceMetadata,
            content: "<p>Synthetic source protected from orphaning</p>",
          },
          s.ports,
        ),
      ).rejects.toThrow(/RunEvidence/u);
      expect(s.objects.size).toBe(0);
    } finally {
      await getDb(ctx.db).execute(sql`
        DROP TRIGGER synthetic_reject_evidence_manifest ON "RunEvidence"
      `);
      await getDb(ctx.db).execute(sql`
        DROP FUNCTION synthetic_reject_evidence_manifest()
      `);
    }
  });

  it("keeps a pending manifest after a partial storage failure and retries the same immutable observation", async () => {
    const s = await scope();
    const input = {
      runId: s.runId,
      workRef: s.first.id,
      callId: "read:partial-storage-failure",
      kind: "web_page" as const,
      sourceMetadata,
      content: "<p>Synthetic partially uploaded source</p>",
    };
    let storageFails = true;
    const ports = {
      storage: {
        put: async (key: string, bytes: Uint8Array) => {
          s.objects.set(key, new Uint8Array(bytes));
          if (storageFails)
            throw new Error("Synthetic partial storage failure");
        },
      },
    };
    await expect(
      retainResearchObservation(ctx.db, input, ports),
    ).rejects.toThrow("Synthetic partial storage failure");
    const pending = await getDb(ctx.db).select().from(runEvidence);
    expect(pending).toHaveLength(1);
    const [manifest] = pending;
    if (!manifest) throw new Error("Synthetic pending manifest unavailable");
    expect(s.objects.has(manifest.objectKey)).toBe(true);
    expect(manifest.sourceMetadata).toMatchObject({
      researchUploadState: "pending",
    });
    const readEvidence = async (evidence: typeof manifest) => {
      const bytes = s.objects.get(evidence.objectKey);
      if (!bytes) throw new Error("Synthetic retained bytes unavailable");
      return new TextDecoder().decode(bytes);
    };
    await expect(
      loadResearchEvidence(
        ctx.db,
        { runId: s.runId, workRef: s.first.id, evidenceIds: [manifest.id] },
        readEvidence,
      ),
    ).rejects.toThrow(/pending/u);
    await expect(
      retainResearchObservation(
        ctx.db,
        { ...input, content: "<p>Changed synthetic source</p>" },
        ports,
      ),
    ).rejects.toThrow(/rebound|changed/u);
    storageFails = false;
    const retained = await retainResearchObservation(ctx.db, input, ports);
    expect(retained.evidenceId).toBe(manifest.id);
    const uploaded = await getDb(ctx.db).select().from(runEvidence);
    expect(uploaded).toHaveLength(1);
    expect(uploaded[0]?.sourceMetadata).toMatchObject({
      researchUploadState: "uploaded",
    });
    expect(s.objects.size).toBe(1);
    expect(
      await loadResearchEvidence(
        ctx.db,
        { runId: s.runId, workRef: s.first.id, evidenceIds: [manifest.id] },
        readEvidence,
      ),
    ).toMatchObject([{ evidenceId: manifest.id, content: input.content }]);
  });

  it("refuses savepoint-bound retention before an outer rollback can orphan uploaded bytes", async () => {
    const s = await scope();
    await expect(
      withTransactionDatabase(ctx.db, async (transactionDb) => {
        await retainResearchObservation(
          transactionDb,
          {
            runId: s.runId,
            workRef: s.first.id,
            callId: "read:outer-rollback",
            kind: "web_page",
            sourceMetadata,
            content: "<p>Synthetic outer transaction rollback</p>",
          },
          s.ports,
        );
        throw new Error("Synthetic outer transaction rollback");
      }),
    ).rejects.toThrow(/transaction|durable/u);
    expect(await getDb(ctx.db).select().from(runEvidence)).toHaveLength(0);
    expect(s.objects.size).toBe(0);
  });

  it("reads retained public sources while the Mac transport is offline", async () => {
    const s = await scope();
    await getDb(ctx.db)
      .update(run)
      .set({ status: "paused_offline" })
      .where(eq(run.id, s.runId));
    const result = await webReadResearch(
      ctx.db,
      { R2_KEY_PREFIX: "synthetic" },
      {
        runId: s.runId,
        workRef: s.first.id,
        callId: "read:offline",
        url: sourceMetadata.sourceURL,
      },
      {
        ...s.ports,
        fetchPage: async () => ({
          status: "fetched",
          url: sourceMetadata.servedURL,
          html: "<p>Green shirt</p>",
          durationMs: 1,
        }),
      },
    );
    expect(result.observation.readableText).toContain("Green shirt");
    expect(s.objects.size).toBe(1);
  });

  it("fences missing, foreign and settled work before retaining any bytes", async () => {
    const s = await scope();
    const foreignRunId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "product_enrichment",
      trigger: "manual",
      status: "running",
    });
    const input = {
      runId: s.runId,
      workRef: s.first.id,
      callId: "read:one",
      kind: "web_page" as const,
      sourceMetadata,
      content: "<p>Green shirt</p>",
    };
    await expect(
      retainResearchObservation(
        ctx.db,
        { ...input, workRef: crypto.randomUUID() },
        s.ports,
      ),
    ).rejects.toThrow(/work/u);
    await expect(
      retainResearchObservation(
        ctx.db,
        { ...input, runId: foreignRunId },
        s.ports,
      ),
    ).rejects.toThrow(/work/u);
    await getDb(ctx.db)
      .update(runTarget)
      .set({ state: "completed", completedAt: new Date() })
      .where(eq(runTarget.id, s.first.id));
    await expect(
      retainResearchObservation(ctx.db, input, s.ports),
    ).rejects.toThrow(/work/u);
    expect(s.objects.size).toBe(0);
  });

  it("replays immutable bytes and refuses call rebinding or changed content", async () => {
    const s = await scope();
    const input = {
      runId: s.runId,
      workRef: s.first.id,
      callId: "read:one",
      kind: "web_page" as const,
      sourceMetadata,
      content: "<p>Green shirt</p>",
    };
    const first = await retainResearchObservation(ctx.db, input, s.ports);
    expect(await retainResearchObservation(ctx.db, input, s.ports)).toEqual(
      first,
    );
    await expect(
      retainResearchObservation(
        ctx.db,
        { ...input, workRef: s.second.id },
        s.ports,
      ),
    ).rejects.toThrow(/replay|rebound/u);
    await expect(
      retainResearchObservation(
        ctx.db,
        { ...input, content: "<p>Blue shirt</p>" },
        s.ports,
      ),
    ).rejects.toThrow(/replay|changed/u);
    expect(s.objects.size).toBe(1);
    const rows = await getDb(ctx.db)
      .select()
      .from(runEvidence)
      .where(eq(runEvidence.runId, s.runId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.targetId).toBe(s.first.id);
  });

  it("refuses upload when the Run actor no longer owns its scoped member", async () => {
    const s = await scope();
    const otherId = userId.parse("synthetic-research-owner");
    await getDb(ctx.db).insert(user).values({
      id: otherId,
      name: "Other synthetic member",
      email: "other-research@example.test",
    });
    const other = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Other research member",
      kind: "member",
      userId: otherId,
    });
    await getDb(ctx.db)
      .update(run)
      .set({ ledgerPartyId: other.id })
      .where(eq(run.id, s.runId));
    await expect(
      retainResearchObservation(
        ctx.db,
        {
          runId: s.runId,
          workRef: s.first.id,
          callId: "read:foreign-owner",
          kind: "web_page",
          sourceMetadata,
          content: "<p>Green shirt</p>",
        },
        s.ports,
      ),
    ).rejects.toThrow(/run|owner/u);
    expect(s.objects.size).toBe(0);
  });

  it("retains visible selected state, order text and images without requiring JSON-LD", async () => {
    const s = await scope();
    const result = await retainResearchObservation(
      ctx.db,
      {
        runId: s.runId,
        workRef: s.first.id,
        callId: "select:green",
        kind: "browser_capture",
        sourceMetadata: {
          ...sourceMetadata,
          observationId: crypto.randomUUID(),
          actions: [
            {
              ref: "option-green",
              kind: "option",
              label: "Green",
              selected: true,
              disabled: false,
            },
          ],
          actionsTruncated: false,
        },
        content:
          '<html><head><link rel="canonical" href="https://shop.example.test/shirt"></head><body><h1>Order EXAMPLE-42</h1><p>Green shirt $24</p><select><option selected>Green</option></select><img src="https://shop.example.test/green.jpg" alt="Green shirt"></body></html>',
      },
      s.ports,
    );
    expect(result.observation.readableText).toContain("Order EXAMPLE-42");
    expect(result.observation.readableText).toContain("Green shirt $24");
    expect(result.observation.servedURL).toBe(sourceMetadata.servedURL);
    expect(result.observation.actions).toMatchObject([
      { label: "Green", selected: true },
    ]);
    expect(result.identifierCandidates).toEqual([]);
    expect(result.imageCandidates).toMatchObject([
      {
        evidenceId: result.evidenceId,
        url: "https://shop.example.test/green.jpg",
      },
    ]);
  });

  it("retains JSON-LD identifiers as scoped candidates instead of accepted facts", async () => {
    const s = await scope();
    const result = await retainResearchObservation(
      ctx.db,
      {
        runId: s.runId,
        workRef: s.first.id,
        callId: "read:structured",
        kind: "web_page",
        sourceMetadata,
        content:
          '<html><head><script type="application/ld+json">{"@type":"Product","sku":"SHIRT-GREEN","mpn":"TEE-24-G","gtin12":"036000291452"}</script></head><body><p>Green shirt</p></body></html>',
      },
      s.ports,
    );
    expect(result.identifierCandidates).toMatchObject([
      {
        evidenceId: result.evidenceId,
        kind: "retailer_sku",
        source: null,
        externalId: "SHIRT-GREEN",
        origin: "json_ld",
      },
      {
        evidenceId: result.evidenceId,
        kind: "manufacturer_part",
        source: null,
        externalId: "TEE-24-G",
        origin: "json_ld",
      },
      {
        evidenceId: result.evidenceId,
        kind: "gtin_14",
        source: "gtin",
        externalId: "00036000291452",
        origin: "json_ld",
      },
    ]);
    const [stored] = await getDb(ctx.db)
      .select()
      .from(runEvidence)
      .where(eq(runEvidence.id, result.evidenceId));
    expect(stored?.sourceMetadata).toMatchObject({
      research: { identifierCandidates: result.identifierCandidates },
    });
  });

  it("returns search results as leads and requires a fetched page for evidence", async () => {
    const s = await scope();
    const binding = {
      R2_KEY_PREFIX: "synthetic",
      AI: {
        websearch: async () =>
          Response.json({
            items: [
              {
                url: sourceMetadata.sourceURL,
                title: "Synthetic shirt",
                description: "Unverified marketing",
              },
            ],
            metadata: { query: "Synthetic green shirt" },
          }),
      },
    };
    const input = {
      runId: s.runId,
      workRef: s.first.id,
      callId: "search:shirt",
      query: "Synthetic green shirt",
    };
    const leads = await webSearchResearch(ctx.db, binding, input);
    expect(leads.results).toMatchObject([
      { url: sourceMetadata.sourceURL, title: "Synthetic shirt" },
    ]);
    expect(
      await getDb(ctx.db)
        .select()
        .from(runEvidence)
        .where(eq(runEvidence.runId, s.runId)),
    ).toEqual([]);
    const read = await webReadResearch(
      ctx.db,
      binding,
      { ...input, callId: "read:shirt", url: sourceMetadata.sourceURL },
      {
        ...s.ports,
        fetchPage: async () => ({
          status: "fetched",
          url: sourceMetadata.servedURL,
          html: "<p>Green shirt</p>",
          durationMs: 1,
        }),
      },
    );
    expect(read.observation.servedURL).toBe(sourceMetadata.servedURL);
    await getDb(ctx.db)
      .update(run)
      .set({ status: "completed" })
      .where(eq(run.id, s.runId));
    await expect(webSearchResearch(ctx.db, binding, input)).rejects.toThrow(
      /run/u,
    );
  });

  it("bounds upstream search error bodies before retaining raw diagnostics", async () => {
    const s = await scope();
    await expect(
      webSearchResearch(
        ctx.db,
        {
          R2_KEY_PREFIX: "synthetic",
          AI: {
            websearch: async () =>
              new Response("upstream unavailable", {
                status: 503,
                headers: { "content-length": String(5 * 1_024 * 1_024 + 1) },
              }),
          },
        },
        {
          runId: s.runId,
          workRef: s.first.id,
          callId: "search:oversized-error",
          query: "Synthetic shirt",
        },
      ),
    ).rejects.toThrow(/exceeds/u);
  });

  it("replays a web read without fetching changed upstream bytes and refuses URL rebinding", async () => {
    const s = await scope();
    let fetches = 0;
    const ports = {
      ...s.ports,
      fetchPage: async () => {
        fetches += 1;
        return {
          status: "fetched" as const,
          url: sourceMetadata.sourceURL,
          html: `<p>Upstream revision ${fetches}</p>`,
          durationMs: 1,
        };
      },
    };
    const input = {
      runId: s.runId,
      workRef: s.first.id,
      callId: "read:immutable",
      url: sourceMetadata.sourceURL,
    };
    const environment = { R2_KEY_PREFIX: "synthetic" };
    const first = await webReadResearch(ctx.db, environment, input, ports);
    expect(await webReadResearch(ctx.db, environment, input, ports)).toEqual(
      first,
    );
    await expect(
      webReadResearch(
        ctx.db,
        environment,
        { ...input, url: "https://shop.example.test/other" },
        ports,
      ),
    ).rejects.toThrow(/replay|rebound/u);
    expect(fetches).toBe(1);
  });

  async function failedPublicUpload(
    storedBytes: "original" | "missing" | "changed",
  ) {
    const s = await scope();
    const original = "<p>Synthetic immutable original page</p>";
    let fetches = 0;
    let puts = 0;
    const ports = {
      storage: {
        put: async (key: string, bytes: Uint8Array) => {
          puts += 1;
          if (storedBytes !== "missing")
            s.objects.set(
              key,
              storedBytes === "original"
                ? new Uint8Array(bytes)
                : new TextEncoder().encode("<p>Changed stored page</p>"),
            );
          throw new Error("Synthetic uncertain storage PUT");
        },
        get: async (key: string) => {
          const bytes = s.objects.get(key);
          if (!bytes) throw new Error("Synthetic pending bytes unavailable");
          return new TextDecoder().decode(bytes);
        },
      },
      fetchPage: async () => {
        fetches += 1;
        return {
          status: "fetched" as const,
          url: sourceMetadata.sourceURL,
          html: fetches === 1 ? original : "<p>Changed upstream page</p>",
          durationMs: 1,
        };
      },
    };
    const input = {
      runId: s.runId,
      workRef: s.first.id,
      callId: "read:uncertain-public-upload",
      url: sourceMetadata.sourceURL,
    };
    const environment = { R2_KEY_PREFIX: "synthetic" };
    await expect(
      webReadResearch(ctx.db, environment, input, ports),
    ).rejects.toThrow("Synthetic uncertain storage PUT");
    const [pending] = await getDb(ctx.db).select().from(runEvidence);
    if (!pending) throw new Error("Synthetic upload manifest missing");
    expect(pending.sourceMetadata).toMatchObject({
      researchUploadState: "pending",
    });
    const assertImmutableUpload = async () => {
      const manifests = await getDb(ctx.db).select().from(runEvidence);
      expect(manifests).toHaveLength(1);
      expect(manifests[0]).toMatchObject({
        id: pending.id,
        runId: pending.runId,
        targetId: pending.targetId,
        objectKey: pending.objectKey,
        checksum: pending.checksum,
        byteSize: pending.byteSize,
      });
      expect(fetches).toBe(1);
      expect(puts).toBe(1);
    };
    return {
      input,
      environment,
      ports,
      pending,
      original,
      assertImmutableUpload,
    };
  }

  it("recovers a web read replay from its immutable uploaded bytes", async () => {
    const s = await failedPublicUpload("original");
    const recovered = await webReadResearch(
      ctx.db,
      s.environment,
      s.input,
      s.ports,
    );
    expect(recovered.evidenceId).toBe(s.pending.id);
    const [uploaded] = await getDb(ctx.db).select().from(runEvidence);
    expect(uploaded?.sourceMetadata).toMatchObject({
      researchUploadState: "uploaded",
    });
    expect(
      await loadResearchEvidence(
        ctx.db,
        { ...s.input, evidenceIds: [s.pending.id] },
        (evidence) => s.ports.storage.get(evidence.objectKey),
      ),
    ).toMatchObject([{ evidenceId: s.pending.id, content: s.original }]);
    await s.assertImmutableUpload();
  });

  it.each(["missing", "changed"] as const)(
    "refuses a web read replay with %s immutable upload bytes",
    async (storedBytes) => {
      const s = await failedPublicUpload(storedBytes);
      await expect(
        webReadResearch(ctx.db, s.environment, s.input, s.ports),
      ).rejects.toThrow(/pending|checksum/u);
      const [stillPending] = await getDb(ctx.db).select().from(runEvidence);
      expect(stillPending?.sourceMetadata).toMatchObject({
        researchUploadState: "pending",
      });
      await s.assertImmutableUpload();
    },
  );

  it.each(["select", "read", "navigate"] as const)(
    "makes capture restart-safe with the server-selected work URL and keeps an explicit bounded target ahead of recovery (%s)",
    async (actionKind) => {
      const s = await scope();
      const commandId = crypto.randomUUID();
      const operationId = `${actionKind}:variant`;
      const command = {
        protocolVersion: 4 as const,
        id: commandId,
        operationId,
        runID: s.runId,
        deadline: "2026-10-07T12:05:00Z",
        operation: resolveResearchBrowserOperation(
          actionKind === "select"
            ? {
                kind: "select",
                observationId: crypto.randomUUID(),
                ref: "color",
                optionRef: "green",
              }
            : actionKind === "navigate"
              ? { kind: "navigate", url: sourceMetadata.sourceURL }
              : { kind: "read" },
          {
            allowedHosts: ["shop.example.test"],
            runShortcode: s.shortcode,
            workRef: s.second.id,
            recoveryURL: "https://shop.example.test/history",
          },
        ),
      };
      const brokerAccountId = crypto.randomUUID();
      const record = {
        commandId,
        command,
        workRef: s.second.id,
        brokerAccountId,
      };
      await insertOperation(getDb(ctx.db), {
        runId: s.runId,
        operationId,
        kind: "browser_command",
        inputFingerprint: "synthetic",
        result: record,
      });
      const result = {
        protocolVersion: 4 as const,
        commandID: commandId,
        operationID: operationId,
        runID: s.runId,
        completedAt: "2026-10-07T12:00:00Z",
        outcome: {
          status: "completed" as const,
          snapshot: {
            observationId: crypto.randomUUID(),
            sourceURL: sourceMetadata.sourceURL,
            servedURL: sourceMetadata.servedURL,
            actions: [
              {
                ref: "green",
                kind: "option" as const,
                label: "Green",
                selected: true,
                disabled: false,
              },
            ],
            actionsTruncated: false,
            title: sourceMetadata.title,
            capturedAt: sourceMetadata.capturedAt,
            dom: await encodeSnapshotDom("<p>Selected green shirt</p>"),
            screenshot: { status: "skipped" as const },
          },
          observation: {
            url: sourceMetadata.servedURL,
            title: sourceMetadata.title,
            readyState: "complete" as const,
            window: null,
            screenRecording: "granted" as const,
            durationMs: 1,
          },
        },
      };
      const input = {
        key: { runId: s.runId, operationId },
        runShortcode: s.shortcode,
        record,
        result,
        allowedHosts: ["shop.example.test"],
        storage: s.ports.storage,
      };
      await expect(
        materializeCapture(ctx.db, {
          ...input,
          result: { ...result, commandID: crypto.randomUUID() },
        }),
      ).rejects.toThrow(/command/u);
      const page = await materializeCapture(ctx.db, input);
      expect(page.research.observation.servedURL).toBe(
        sourceMetadata.servedURL,
      );
      expect(page.research.observation.actions).toMatchObject([
        { label: "Green", selected: true },
      ]);
      const [evidence] = await getDb(ctx.db)
        .select()
        .from(runEvidence)
        .where(eq(runEvidence.id, page.domEvidenceId));
      expect(evidence?.targetId).toBe(s.second.id);
      expect(evidence?.sourceMetadata).toMatchObject({ brokerAccountId });
      expect(s.objects.size).toBe(1);
      await setOperationResult(getDb(ctx.db), input.key, {
        ...record,
        page,
        observationDelivered: true,
      });
      await materializeCapture(ctx.db, input);
      expect(
        (await readOperation(getDb(ctx.db), input.key))?.result,
      ).toMatchObject({ observationDelivered: true });
    },
  );
});
