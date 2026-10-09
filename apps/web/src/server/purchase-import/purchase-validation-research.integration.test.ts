import { resolveRunFindingInput } from "@cubby/schemas/problems";
import {
  acceptedSourceOrder,
  initiateRunEvidenceUploadInput,
  purchaseAgentEvent,
} from "@cubby/schemas/purchase-import";
import {
  researchAttachmentOriginal,
  researchWorkResolve,
} from "@cubby/schemas/research-tools";
import {
  targetedImportStartInput,
  targetedImportStartOutput,
} from "@cubby/schemas/run";
import { sha256Hex } from "@cubby/shared/sha256";
import { fromPartial } from "@total-typescript/shoehorn";
import { and, eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { runContract } from "~/contracts/run.contract";
import { setCfEnv } from "~/server/cf-env";
import {
  expense,
  importSourceClaim,
  importSourceOrder,
  product,
  purchase,
  run,
  runEvidence,
  runFinding,
  runTarget,
  user,
} from "~/server/db/schema";
import { runHandlers } from "~/server/operations/run.server";
import { getDb } from "~/server/repo/database-helpers";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { requireActor } from "~/server/request-context";
import { actorSnapshot } from "~/server/runs/ensure-run";
import { createTestRequestContext } from "~/server/testing/request-context";

import { resolveRunFinding } from "./findings";
import { resolveImportResearch } from "./research-import";
import { retainResearchObservation } from "./research-observations";
import { researchServiceFor } from "./research-service";
import type { ResearchAssessor } from "./research-support";
import {
  initiateRunEvidenceUpload,
  receiveRunEvidenceUpload,
} from "./run-evidence";

// Public launch -> Next -> retained original -> Resolve -> member correction.
// Failures: legacy/null admission, Vendor/Mac prerequisites, an accepted
// discrepancy silently completing, automatic money writes, duplicated replay
// findings, stale member corrections, wrong-task originals, unfinished uploads,
// stale/foreign selected sources, and raw historical target copying.
describe("Purchase validation research", () => {
  const ctx = withTestDb();
  afterEach(() => setCfEnv(undefined));

  async function fixture() {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Example validation member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const seller = await insertWithShortcode(ctx.db, "vendor", {
      name: "Example offline service provider",
      website: null,
      browserDomains: [],
    });
    const order = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: seller.id,
      orderId: null,
      statedTotal: 18,
    });
    const line = await insertWithShortcode(ctx.db, "expense", {
      purchaseId: order.id,
      name: "Example annual service",
      cost: 18,
      costType: "services",
      trade: "other",
      date: "2026-10-01",
      lineKind: "principal",
    });
    const events: unknown[] = [];
    const environment = fromPartial<Env>({
      BETTER_AUTH_SECRET: "synthetic-validation-upload-secret",
      R2_KEY_PREFIX: "synthetic/validation",
      PURCHASE_AGENT_QUEUE: {
        send: async (event: unknown) => {
          events.push(purchaseAgentEvent.parse(event));
        },
      },
    });
    setCfEnv(environment);
    const context = {
      ...requireActor(
        createTestRequestContext(ctx.db, {
          auth: { userId: ctx.actor.userId },
        }),
      ),
      signal: new AbortController().signal,
    };
    const bytes = new Map<string, Uint8Array>();
    const storage = {
      put: async (key: string, data: Uint8Array) => {
        bytes.set(key, data);
      },
      get: async (key: string) => {
        const data = bytes.get(key);
        if (!data) throw new Error("Synthetic original is unavailable.");
        return new TextDecoder().decode(data);
      },
    };
    const start = async (selected = order, sourceId: string | null = null) => {
      const input = targetedImportStartInput.parse({
        purpose: "purchase_validation",
        purchaseId: selected.shortcode,
        sourceId,
      });
      const result = targetedImportStartOutput.parse(
        await runHandlers.runs.startTargeted!.run(context, input),
      );
      const admission = result.runs[0];
      if (!admission?.run) throw new Error("Validation Run was not admitted.");
      const runId = await resolveOrThrow(ctx.db, "run", admission.run.id);
      const [target] = await getDb(ctx.db)
        .select()
        .from(runTarget)
        .where(eq(runTarget.runId, runId));
      if (!target) throw new Error("Validation task is missing.");
      const services = researchServiceFor(ctx.db, environment, runId, {
        observations: { storage, keyPrefix: environment.R2_KEY_PREFIX },
        readAttachment: async (key) => {
          const data = bytes.get(key);
          if (!data) throw new Error("Synthetic upload is not complete.");
          return data;
        },
      });
      return { admission, input, runId, target, services };
    };
    const historicalRun = async (
      purpose: Parameters<typeof importRunAgentIdentity>[1],
      status: typeof run.$inferSelect.status,
      owner = party,
    ) => {
      if (!owner.userId)
        throw new Error(
          "Historical fixture requires a real initiating member.",
        );
      const actorId = userId.parse(owner.userId);
      const snapshot = await actorSnapshot(getDb(ctx.db), actorId);
      if (snapshot.ledgerPartyId !== owner.id)
        throw new Error(
          "Historical fixture actor does not own its member party.",
        );
      const id = runEntityId.parse(crypto.randomUUID());
      return insertWithShortcode(ctx.db, "run", {
        id,
        purpose,
        status,
        trigger: "manual",
        ledgerPartyId: owner.id,
        actorUserId: actorId,
        actorName: snapshot.actorName,
        actorEmail: snapshot.actorEmail,
        actorLedgerPartyShortcode: snapshot.ledgerPartyShortcode,
        actorLedgerPartyName: snapshot.ledgerPartyName,
        actorLedgerPartyKind: snapshot.ledgerPartyKind,
        dispatchEventId: crypto.randomUUID(),
        agentSessionId: importRunAgentIdentity(id, purpose),
        input: null,
      });
    };
    return {
      party,
      seller,
      order,
      line,
      events,
      environment,
      context,
      bytes,
      storage,
      start,
      historicalRun,
    };
  }

  async function acceptedOriginal(
    f: Awaited<ReturnType<typeof fixture>>,
    accountId: string | null = null,
    staleAlias = false,
  ) {
    const historical = await f.historicalRun("mail_import", "completed");
    const [root] = await getDb(ctx.db)
      .insert(importSourceClaim)
      .values({
        ledgerPartyId: f.party.id,
        kind: "browser_order",
        externalKey: "https://receipt.example.test/accepted",
        checksum: staleAlias ? "b".repeat(64) : "a".repeat(64),
        vendorAccountId: accountId
          ? parseEntityId("vendorAccount", accountId)
          : null,
        firstRunId: historical.id,
        lastRunId: historical.id,
      })
      .returning();
    if (!root) throw new Error("Accepted original root missing.");
    const [alias] = staleAlias
      ? await getDb(ctx.db)
          .insert(importSourceClaim)
          .values({
            ledgerPartyId: f.party.id,
            kind: root.kind,
            externalKey: "https://receipt.example.test/historical",
            checksum: "a".repeat(64),
            canonicalClaimId: root.id,
            firstRunId: historical.id,
            lastRunId: historical.id,
          })
          .returning()
      : [root];
    if (!alias) throw new Error("Historical original alias missing.");
    const [association] = await getDb(ctx.db)
      .insert(importSourceOrder)
      .values({
        sourceClaimId: alias.id,
        orderKey: "synthetic-validation-original",
        purchaseId: f.order.id,
        checksum: "a".repeat(64),
        outputFingerprint: "c".repeat(64),
        originalOrder: acceptedSourceOrder.parse({
          checksum: "a".repeat(64),
          extraction: {
            status: "ready",
            candidate: {
              orderId: null,
              orderedAt: null,
              merchant: f.seller.name,
              currency: "USD",
              printedGrandTotal: 18,
              lines: [
                { title: f.line.name, amount: 18, lineKind: "principal" },
              ],
              payments: [],
              allShipmentsDelivered: false,
            },
          },
        }),
      })
      .returning();
    if (!association) throw new Error("Accepted original association missing.");
    return { association, root, alias };
  }

  it("marks a historical alias original unusable when its canonical original checksum changed", async () => {
    const f = await fixture();
    const source = await acceptedOriginal(f, null, true);
    const preview = runContract.ops.targetedLaunch.output.parse(
      await runHandlers.runs.targetedLaunch!.run(f.context, {
        purpose: "purchase_validation",
        targetId: f.order.shortcode,
      }),
    );
    expect(preview.purchase).toMatchObject({
      canValidate: true,
      sources: [
        {
          id: source.association.id,
          usable: false,
          default: false,
          vendorAccountId: null,
        },
      ],
    });
    await expect(
      runHandlers.runs.startTargeted!.run(
        f.context,
        targetedImportStartInput.parse({
          purpose: "purchase_validation",
          purchaseId: f.order.shortcode,
          sourceId: source.association.id,
        }),
      ),
    ).rejects.toThrow(/stale|original/u);
    expect(await getDb(ctx.db).select().from(importSourceOrder)).toEqual([
      source.association,
    ]);
    expect(await getDb(ctx.db).select().from(expense)).toEqual([f.line]);
  });

  it("keeps an owned original cloud-usable without advertising or admitting another member's browser transport", async () => {
    const f = await fixture();
    const otherId = userId.parse(crypto.randomUUID());
    await getDb(ctx.db).insert(user).values({
      id: otherId,
      name: "Other browser member",
      email: "other-browser-member@example.test",
    });
    const other = await insertWithShortcode(ctx.db, "ledgerParty", {
      kind: "member",
      name: "Other browser owner",
      userId: otherId,
    });
    const account = await insertWithShortcode(ctx.db, "vendorAccount", {
      vendorId: f.seller.id,
      ledgerPartyId: other.id,
      label: "Other browser",
      browserSyncEnabled: true,
      status: "active",
    });
    const source = await acceptedOriginal(f, account.id);
    const preview = runContract.ops.targetedLaunch.output.parse(
      await runHandlers.runs.targetedLaunch!.run(f.context, {
        purpose: "purchase_validation",
        targetId: f.order.shortcode,
      }),
    );
    expect(preview.purchase?.sources).toMatchObject([
      {
        id: source.association.id,
        usable: true,
        vendorAccountId: null,
        vendorAccountLabel: null,
      },
    ]);
    const start = targetedImportStartOutput.parse(
      await runHandlers.runs.startTargeted!.run(
        f.context,
        targetedImportStartInput.parse({
          purpose: "purchase_validation",
          purchaseId: f.order.shortcode,
          sourceId: source.association.id,
        }),
      ),
    );
    const code = start.runs[0]?.run?.id;
    if (!code) throw new Error("Cloud validation admission missing.");
    const id = await resolveOrThrow(ctx.db, "run", code);
    expect(
      (await getDb(ctx.db).select().from(run).where(eq(run.id, id)))[0]
        ?.vendorAccountId,
    ).toBeNull();
    expect(
      await researchServiceFor(ctx.db, f.environment, id).researchNext(
        {},
        crypto.randomUUID(),
      ),
    ).toMatchObject({ status: "working", work: { kind: "purchase" } });
    expect(await getDb(ctx.db).select().from(importSourceClaim)).toEqual([
      source.root,
    ]);
  });

  it("admits the same optional owned browser transport that the selected original preview advertises", async () => {
    const f = await fixture();
    const chosen = await insertWithShortcode(ctx.db, "vendorAccount", {
      vendorId: f.seller.id,
      ledgerPartyId: f.party.id,
      label: "Selected browser",
      browserSyncEnabled: true,
      status: "active",
    });
    const source = await acceptedOriginal(f, chosen.id);
    const preview = runContract.ops.targetedLaunch.output.parse(
      await runHandlers.runs.targetedLaunch!.run(f.context, {
        purpose: "purchase_validation",
        targetId: f.order.shortcode,
      }),
    );
    expect(preview.purchase?.sources).toMatchObject([
      {
        id: source.association.id,
        usable: true,
        vendorAccountId: chosen.shortcode,
        vendorAccountLabel: chosen.label,
      },
    ]);
    const started = targetedImportStartOutput.parse(
      await runHandlers.runs.startTargeted!.run(
        f.context,
        targetedImportStartInput.parse({
          purpose: "purchase_validation",
          purchaseId: f.order.shortcode,
          sourceId: source.association.id,
        }),
      ),
    );
    const code = started.runs[0]?.run?.id;
    if (!code) throw new Error("Preferred validation admission missing.");
    const id = await resolveOrThrow(ctx.db, "run", code);
    expect(
      (await getDb(ctx.db).select().from(run).where(eq(run.id, id)))[0]
        ?.vendorAccountId,
    ).toBe(chosen.id);
    expect(await getDb(ctx.db).select().from(importSourceOrder)).toEqual([
      source.association,
    ]);
  });

  async function supportedDiscrepancy(
    f: Awaited<ReturnType<typeof fixture>>,
    started: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["start"]>>,
    currency = "USD",
  ) {
    const original = await retainResearchObservation(
      ctx.db,
      {
        runId: started.runId,
        workRef: started.target.id,
        callId: crypto.randomUUID(),
        kind: "web_page",
        sourceMetadata: { sourceURL: "https://receipt.example.test/original" },
        content:
          `<h1>Original receipt for ${f.order.shortcode}</h1>` +
          "<p>Example annual service. Printed grand total USD 10.</p>",
      },
      { storage: f.storage, keyPrefix: f.environment.R2_KEY_PREFIX },
    );
    const proposal = researchWorkResolve.parse({
      workRef: started.target.id,
      status: "verified",
      identity: {
        evidenceIds: [original.evidenceId],
        reasoning:
          "This original identifies the selected recorded acquisition.",
      },
      facts: [
        {
          evidenceId: original.evidenceId,
          fieldPath: "statedTotal",
          value: 10,
          support: {
            observation: "Printed grand total USD 10.",
            reasoning: "The exact acquisition's printed total is ten dollars.",
          },
        },
      ],
      orders: [
        {
          purchaseRef: f.order.shortcode,
          evidenceIds: [original.evidenceId],
          reasoning:
            "The original supplies the selected acquisition's itemization.",
          candidate: {
            orderId: null,
            orderedAt: "2026-10-01T12:00:00Z",
            merchant: "Example service provider",
            currency,
            printedGrandTotal: 10,
            lines: [{ title: f.line.name, amount: 10, lineKind: "principal" }],
            payments: [],
            allShipmentsDelivered: false,
          },
          productResolutions: [{ kind: "expense_only", lineIndex: 0 }],
        },
      ],
      detail:
        "Supported original disagrees with the recorded eighteen dollars.",
    });
    const assess: ResearchAssessor = async ({ context }) => {
      expect(JSON.stringify(context)).toContain(f.line.name);
      expect(JSON.stringify(context)).toContain(f.order.shortcode);
      return {
        identityVerified: true,
        acceptedFacts: [0],
        acceptedOrders: [0],
        acceptedIdentifiers: [],
        acceptedImages: [],
        acceptedEmailLinks: [],
        rejected: [],
      };
    };
    const input = {
      runId: started.runId,
      workRef: started.target.id,
      callId: crypto.randomUUID(),
      proposal,
    };
    const ports = {
      assess,
      readEvidence: (row: typeof runEvidence.$inferSelect) =>
        f.storage.get(row.objectKey),
    };
    const result = await resolveImportResearch(ctx.db, input, ports);
    return { result, input, ports };
  }

  it("admits a cloud Purchase without website, browser account, or order ID, retains an accepted discrepancy for review, and applies money changes only after member review", async () => {
    const f = await fixture();
    const preview = runContract.ops.targetedLaunch.output.parse(
      await runHandlers.runs.targetedLaunch!.run(f.context, {
        purpose: "purchase_validation",
        targetId: f.order.shortcode,
      }),
    );
    expect(JSON.stringify(preview)).toContain(f.order.shortcode);
    const started = await f.start();
    const replayStart = targetedImportStartOutput.parse(
      await runHandlers.runs.startTargeted!.run(f.context, started.input),
    );
    expect(replayStart).toMatchObject({
      runs: [
        {
          created: false,
          run: null,
          blockingRun: { id: started.admission.run!.id },
        },
      ],
    });
    expect(f.events).toHaveLength(1);
    const next = await started.services.researchNext({}, crypto.randomUUID());
    expect(next).toMatchObject({
      status: "working",
      work: { kind: "purchase" },
    });
    expect(JSON.stringify(next)).toContain(f.order.shortcode);
    expect(JSON.stringify(next)).toContain(f.line.name);
    const [admitted] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.id, started.runId));
    expect(admitted).toMatchObject({
      status: "running",
      vendorAccountId: null,
      input: { kind: "purchase_validation_research" },
    });
    const resolution = await supportedDiscrepancy(f, started);
    expect(resolution.result.proposedFacts).toHaveLength(1);
    expect(await getDb(ctx.db).select().from(expense)).toEqual([f.line]);
    expect(await getDb(ctx.db).select().from(purchase)).toEqual([f.order]);
    expect(await getDb(ctx.db).select().from(importSourceClaim)).toEqual([]);
    expect(await getDb(ctx.db).select().from(importSourceOrder)).toEqual([]);
    expect(await getDb(ctx.db).select().from(product)).toEqual([]);
    const findings = await getDb(ctx.db)
      .select()
      .from(runFinding)
      .where(eq(runFinding.runId, started.runId));
    expect(findings).toHaveLength(1);
    const finding = findings[0];
    if (!finding)
      throw new Error("Supported discrepancy has no review finding.");
    expect(finding).toMatchObject({
      ledgerPartyId: f.party.id,
      entityKind: "purchase",
      entityId: f.order.id,
      kind: "sum_mismatch",
      status: "open",
      autoApplied: false,
    });
    expect(
      await resolveImportResearch(ctx.db, resolution.input, resolution.ports),
    ).toEqual(resolution.result);
    expect(
      await getDb(ctx.db)
        .select()
        .from(runFinding)
        .where(eq(runFinding.runId, started.runId)),
    ).toEqual(findings);
    await started.services.researchNext({}, crypto.randomUUID());
    const [review] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.id, started.runId));
    expect(review?.status).toBe("needs_review");
    const snapshot = z
      .object({ reviewSnapshot: z.object({ fingerprint: z.string() }) })
      .parse(finding.proposedFix);
    await resolveRunFinding(
      ctx.db,
      resolveRunFindingInput.parse({
        id: finding.id,
        action: "apply",
        reviewedFingerprint: snapshot.reviewSnapshot.fingerprint,
      }),
      ctx.actor,
    );
    const [corrected] = await getDb(ctx.db)
      .select()
      .from(expense)
      .where(eq(expense.id, f.line.id));
    const [correctedOrder] = await getDb(ctx.db)
      .select()
      .from(purchase)
      .where(eq(purchase.id, f.order.id));
    expect(corrected?.cost).toBe(10);
    expect(correctedOrder?.statedTotal).toBe(10);
    expect(await getDb(ctx.db).select().from(importSourceClaim)).toEqual([]);
    expect(await getDb(ctx.db).select().from(product)).toEqual([]);
  });

  it("keeps a supported foreign-currency discrepancy advisory without issuing an applyable money correction", async () => {
    const f = await fixture();
    const started = await f.start();
    const resolved = await supportedDiscrepancy(f, started, "EUR");
    expect(resolved.result.status).toBe("researched_with_gaps");
    const [finding] = await getDb(ctx.db)
      .select()
      .from(runFinding)
      .where(eq(runFinding.runId, started.runId));
    expect(finding).toMatchObject({ proposedFix: null, autoApplied: false });
    expect(await getDb(ctx.db).select().from(expense)).toEqual([f.line]);
    expect(await getDb(ctx.db).select().from(purchase)).toEqual([f.order]);
  });

  it("refuses unsupported positive validation and unrelated retirement of an existing Purchase", async () => {
    const f = await fixture();
    const started = await f.start();
    for (const status of ["verified", "unrelated"] as const) {
      const proposal = researchWorkResolve.parse({
        workRef: started.target.id,
        status,
        identity: {
          evidenceIds: [],
          reasoning: "No original identifies this recorded acquisition.",
        },
        detail:
          "An attempted original may be unrelated; the existing Purchase remains valid.",
      });
      await expect(
        resolveImportResearch(
          ctx.db,
          {
            runId: started.runId,
            workRef: started.target.id,
            callId: crypto.randomUUID(),
            proposal,
          },
          {
            assess: async () => ({
              identityVerified: false,
              acceptedFacts: [],
              acceptedOrders: [],
              acceptedEmailLinks: [],
              acceptedIdentifiers: [],
              acceptedImages: [],
              rejected: [],
            }),
          },
        ),
      ).rejects.toThrow(/identity|unrelated|source/u);
    }
    expect(await getDb(ctx.db).select().from(expense)).toEqual([f.line]);
    expect(await getDb(ctx.db).select().from(purchase)).toEqual([f.order]);
    expect(await getDb(ctx.db).select().from(runFinding)).toEqual([]);
    expect(
      (
        await getDb(ctx.db).select().from(run).where(eq(run.id, started.runId))
      )[0]?.retiredAt,
    ).toBeNull();
  });

  it("continues a member-declared unavailable original as fresh typed cloud work without closing the Purchase task", async () => {
    const f = await fixture();
    const started = await f.start();
    await getDb(ctx.db)
      .update(run)
      .set({ status: "needs_review", endedAt: new Date() })
      .where(eq(run.id, started.runId));
    await getDb(ctx.db)
      .update(runTarget)
      .set({ state: "unresolved", outcome: "no_source_found" })
      .where(eq(runTarget.id, started.target.id));
    const [prior] = await getDb(ctx.db)
      .select()
      .from(runTarget)
      .where(eq(runTarget.id, started.target.id));
    const controlled = runContract.ops.control.output.parse(
      await runHandlers.runs.control!.run(f.context, {
        runId: started.admission.run!.id,
        action: "no_evidence_available",
      }),
    );
    if (!controlled.successor)
      throw new Error("Unavailable original has no typed continuation.");
    const id = await resolveOrThrow(
      ctx.db,
      "run",
      controlled.successor.publicId,
    );
    const [successor] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.id, id));
    expect(successor).toMatchObject({
      status: "running",
      input: {
        kind: "purchase_validation_research",
        purchases: [
          { purchaseId: f.order.id, manualEvidenceUnavailable: true },
        ],
      },
    });
    expect(
      await researchServiceFor(ctx.db, f.environment, id).researchNext(
        {},
        crypto.randomUUID(),
      ),
    ).toMatchObject({
      status: "working",
      work: {
        kind: "purchase",
        evidenceStatus: "needs_evidence",
        manualEvidenceUnavailable: true,
      },
    });
    expect(
      await getDb(ctx.db)
        .select()
        .from(runTarget)
        .where(eq(runTarget.id, started.target.id)),
    ).toEqual([prior]);
    expect(await getDb(ctx.db).select().from(expense)).toEqual([f.line]);
    expect(await getDb(ctx.db).select().from(purchase)).toEqual([f.order]);
  });

  it("refuses a member correction after the recorded Expense changes, preserving the new money and open finding", async () => {
    const f = await fixture();
    const started = await f.start();
    await started.services.researchNext({}, crypto.randomUUID());
    await supportedDiscrepancy(f, started);
    const [finding] = await getDb(ctx.db)
      .select()
      .from(runFinding)
      .where(eq(runFinding.runId, started.runId));
    if (!finding) throw new Error("Supported discrepancy finding is missing.");
    const snapshot = z
      .object({ reviewSnapshot: z.object({ fingerprint: z.string() }) })
      .parse(finding.proposedFix);
    await getDb(ctx.db)
      .update(expense)
      .set({ cost: 19 })
      .where(eq(expense.id, f.line.id));
    await expect(
      resolveRunFinding(
        ctx.db,
        resolveRunFindingInput.parse({
          id: finding.id,
          action: "apply",
          reviewedFingerprint: snapshot.reviewSnapshot.fingerprint,
        }),
        ctx.actor,
      ),
    ).rejects.toThrow(/changed|stale|snapshot/u);
    const [line] = await getDb(ctx.db)
      .select()
      .from(expense)
      .where(eq(expense.id, f.line.id));
    expect(line?.cost).toBe(19);
    expect(await getDb(ctx.db).select().from(purchase)).toEqual([f.order]);
    expect(
      await getDb(ctx.db)
        .select()
        .from(runFinding)
        .where(eq(runFinding.id, finding.id)),
    ).toEqual([finding]);
  });

  it("keeps an unfinished upload as needs_evidence while cloud work remains executable, then exposes only the verified original bytes", async () => {
    const f = await fixture();
    const started = await f.start();
    await started.services.researchNext({}, crypto.randomUUID());
    const content = "Synthetic receipt image original, total USD 10.";
    const checksum = await sha256Hex(content);
    const upload = await initiateRunEvidenceUpload(
      ctx.db,
      initiateRunEvidenceUploadInput.parse({
        runId: started.admission.run!.id,
        targetId: started.target.id,
        kind: "manual_upload",
        filename: "example-receipt.png",
        contentType: "image/png",
        byteSize: new TextEncoder().encode(content).byteLength,
        checksum,
      }),
      ctx.actor.userId,
    );
    expect(
      await started.services.researchObserve(
        { workRef: started.target.id, action: { kind: "read" } },
        crypto.randomUUID(),
      ),
    ).toMatchObject({ status: "needs_evidence", workRef: started.target.id });
    expect(
      await started.services.researchNext({}, crypto.randomUUID()),
    ).toMatchObject({ status: "working", work: { kind: "purchase" } });
    const [pending] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.id, started.runId));
    expect(pending?.status).toBe("running");
    expect(f.bytes.size).toBe(0);
    expect(
      (
        await receiveRunEvidenceUpload(
          ctx.db,
          new Request(upload.uploadUrl, {
            method: "PUT",
            headers: { "content-type": "image/png" },
            body: content,
          }),
          f.storage,
        )
      ).status,
    ).toBe(204);
    await getDb(ctx.db)
      .update(run)
      .set({ coordinatorStartedAt: new Date() })
      .where(eq(run.id, started.runId));
    const beforeWake = f.events.length;
    await runHandlers.runs.control!.run(f.context, {
      runId: started.admission.run!.id,
      action: "retry_dispatch",
    });
    expect(f.events).toHaveLength(beforeWake + 1);
    expect(
      (
        await getDb(ctx.db).select().from(run).where(eq(run.id, started.runId))
      )[0]?.status,
    ).toBe("running");
    const observed = await started.services.researchObserve(
      { workRef: started.target.id, action: { kind: "read" } },
      crypto.randomUUID(),
    );
    const output = z
      .object({
        status: z.literal("observed"),
        evidenceId: z.uuid(),
        originalAttachment: researchAttachmentOriginal,
      })
      .parse(observed);
    expect(output.originalAttachment).toMatchObject({
      checksum,
      filename: "example-receipt.png",
      mimeType: "image/png",
      dataBase64: Buffer.from(content).toString("base64"),
    });
    expect(output.originalAttachment.attachmentRef).toBe(upload.evidenceId);
    expect(await getDb(ctx.db).select().from(expense)).toEqual([f.line]);
    expect(await getDb(ctx.db).select().from(runFinding)).toEqual([]);
  });

  it("refuses another task's retained original before assessment or findings even when both tasks belong to the member", async () => {
    const f = await fixture();
    const started = await f.start();
    await started.services.researchNext({}, crypto.randomUUID());
    const other = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: f.seller.id,
      statedTotal: 27,
    });
    const second = await f.start(other);
    const evidence = await retainResearchObservation(
      ctx.db,
      {
        runId: second.runId,
        workRef: second.target.id,
        callId: crypto.randomUUID(),
        kind: "web_page",
        sourceMetadata: { sourceURL: "https://receipt.example.test/other" },
        content: "Original for a different acquisition, total USD 27.",
      },
      { storage: f.storage, keyPrefix: f.environment.R2_KEY_PREFIX },
    );
    let assessed = false;
    const proposal = researchWorkResolve.parse({
      workRef: started.target.id,
      status: "verified",
      identity: {
        evidenceIds: [evidence.evidenceId],
        reasoning: "This reference was issued for another work item.",
      },
      facts: [
        {
          evidenceId: evidence.evidenceId,
          fieldPath: "statedTotal",
          value: 27,
          support: {
            observation: "Total USD 27.",
            reasoning: "This is a different acquisition.",
          },
        },
      ],
      detail: "Wrong task original must not authorize a correction.",
    });
    await expect(
      resolveImportResearch(
        ctx.db,
        {
          runId: started.runId,
          workRef: started.target.id,
          callId: crypto.randomUUID(),
          proposal,
        },
        {
          readEvidence: (row) => f.storage.get(row.objectKey),
          assess: async () => {
            assessed = true;
            return {
              identityVerified: true,
              acceptedFacts: [0],
              acceptedOrders: [],
              acceptedIdentifiers: [],
              acceptedImages: [],
              acceptedEmailLinks: [],
              rejected: [],
            };
          },
        },
      ),
    ).rejects.toThrow(/task|belong/u);
    expect(assessed).toBe(false);
    expect(await getDb(ctx.db).select().from(expense)).toEqual([f.line]);
    expect(await getDb(ctx.db).select().from(runFinding)).toEqual([]);
  });

  it.each(["foreign", "mismatched", "stale"] as const)(
    "refuses a %s selected source without admitting a Run or stealing source history",
    async (kind) => {
      const f = await fixture();
      await getDb(ctx.db)
        .update(purchase)
        .set({ orderId: "EXAMPLE-VALIDATION" })
        .where(eq(purchase.id, f.order.id));
      const sourceOwner = await (async () => {
        if (kind !== "foreign") return f.party;
        const otherUserId = userId.parse(crypto.randomUUID());
        await getDb(ctx.db).insert(user).values({
          id: otherUserId,
          name: "Other original member",
          email: "other-validation-member@example.test",
        });
        return insertWithShortcode(ctx.db, "ledgerParty", {
          name: "Other original owner",
          kind: "member",
          userId: otherUserId,
        });
      })();
      const historical = await f.historicalRun(
        "mail_import",
        "completed",
        sourceOwner,
      );
      const [claim] = await getDb(ctx.db)
        .insert(importSourceClaim)
        .values({
          ledgerPartyId: sourceOwner.id,
          kind: "mail_message",
          externalKey: "synthetic-validation-original",
          checksum: kind === "stale" ? "b".repeat(64) : "a".repeat(64),
          firstRunId: historical.id,
          lastRunId: historical.id,
        })
        .returning();
      if (!claim) throw new Error("Synthetic selected source missing.");
      const other =
        kind === "mismatched"
          ? await insertWithShortcode(ctx.db, "purchase", {
              vendorId: f.seller.id,
              statedTotal: 18,
            })
          : f.order;
      const [association] = await getDb(ctx.db)
        .insert(importSourceOrder)
        .values({
          sourceClaimId: claim.id,
          orderKey: "synthetic-validation-order",
          purchaseId: other.id,
          checksum: "a".repeat(64),
          outputFingerprint: "c".repeat(64),
          originalOrder: acceptedSourceOrder.parse({
            checksum: "a".repeat(64),
            extraction: {
              status: "ready",
              candidate: {
                orderId: null,
                orderedAt: null,
                merchant: "Example service provider",
                currency: "USD",
                printedGrandTotal: 18,
                lines: [
                  { title: f.line.name, amount: 18, lineKind: "principal" },
                ],
                payments: [],
                allShipmentsDelivered: false,
              },
            },
          }),
        })
        .returning();
      if (!association)
        throw new Error("Synthetic source association missing.");
      await expect(f.start(f.order, association.id)).rejects.toThrow(
        /source|owned|replayable|fresh|checksum/u,
      );
      expect(
        await getDb(ctx.db)
          .select()
          .from(run)
          .where(eq(run.purpose, "purchase_validation")),
      ).toEqual([]);
      expect(await getDb(ctx.db).select().from(importSourceClaim)).toEqual([
        claim,
      ]);
      expect(await getDb(ctx.db).select().from(importSourceOrder)).toEqual([
        association,
      ]);
      expect(f.events).toEqual([]);
    },
  );

  it("converts historical null-input Purchase-only work into a fresh typed successor without copying stale context or changing historical targets", async () => {
    const f = await fixture();
    const historical = await f.historicalRun(
      "purchase_validation",
      "needs_review",
    );
    const [target] = await getDb(ctx.db)
      .insert(runTarget)
      .values({
        runId: historical.id,
        entityKind: "purchase",
        entityId: f.order.id,
        state: "unresolved",
        targetFingerprint: "a".repeat(64),
        warning: "Historical validation has no admitted original.",
      })
      .returning();
    if (!target) throw new Error("Historical Purchase task missing.");
    const control = runContract.ops.control.output.parse(
      await runHandlers.runs.control!.run(f.context, {
        runId: historical.shortcode,
        action: "restart",
      }),
    );
    if (!control.successor)
      throw new Error("Typed validation successor missing.");
    const successorId = await resolveOrThrow(
      ctx.db,
      "run",
      control.successor.publicId,
    );
    const [successor] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.id, successorId));
    expect(successor).toMatchObject({
      predecessorRunId: historical.id,
      status: "running",
      vendorAccountId: null,
      input: { kind: "purchase_validation_research" },
    });
    expect(
      await researchServiceFor(ctx.db, f.environment, successorId).researchNext(
        {},
        crypto.randomUUID(),
      ),
    ).toMatchObject({ status: "working", work: { kind: "purchase" } });
    expect(
      await getDb(ctx.db)
        .select()
        .from(runTarget)
        .where(eq(runTarget.runId, historical.id)),
    ).toEqual([target]);
    const [fresh] = await getDb(ctx.db)
      .select()
      .from(runTarget)
      .where(
        and(
          eq(runTarget.runId, successorId),
          eq(runTarget.entityId, f.order.id),
        ),
      );
    expect(fresh?.targetFingerprint).not.toBe(target.targetFingerprint);
    const replay = runContract.ops.control.output.parse(
      await runHandlers.runs.control!.run(f.context, {
        runId: historical.shortcode,
        action: "restart",
      }),
    );
    expect(replay.successor?.publicId).toBe(control.successor.publicId);
    expect(replay.successor?.created).toBe(false);
  });
});
import { parseEntityId, runEntityId, userId } from "@cubby/schemas/identifiers";
import { importRunAgentIdentity } from "@cubby/schemas/import-run-agent";
