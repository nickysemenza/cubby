/** Plausible failures: evidence-free negative verdict omits its primary source;
 * heading-only readers survive cleanup; failed proposals retain quotes; cleanup
 * loses its R2 keys on interruption; disposal runs inside its own active tool;
 * replay revives disposed history; a positive/human link is erased; successor
 * admission repeats or silently drops unsupported remaining work; a reader's
 * in-flight R2 upload commits after the retirement planner scanned evidence. */
import { MAILBOX_RESEARCH_VERSION } from "@cubby/schemas/mailbox-research";
import { researchWorkResolve } from "@cubby/schemas/research-tools";
import { sha256Hex } from "@cubby/shared/sha256";
import { eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  importSourceClaim,
  importSourceOrder,
  mailboxMessage,
  orderMail,
  orderMailCandidateDecision,
  orderMailEvent,
  researchRetention,
  researchSourceExposure,
  run,
  runEvidence,
  runFactEvidence,
  runOperation,
  runTarget,
} from "~/server/db/schema";
import { withTransaction, getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { resolveImportResearch } from "./research-import";
import { retainResearchObservation } from "./research-observations";
import {
  processResearchRetention,
  requestResearchRetention,
  withResearchSourceAdmission,
} from "./research-retention";

describe("unrelated research retention", () => {
  const ctx = withTestDb();
  async function fixture(legacyMailbox = false) {
    const member = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic privacy member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const content = "SYNTHETIC-UNRELATED-CONTENT-TO-ERASE";
    const checksum = await sha256Hex(content);
    const [source] = await getDb(ctx.db)
      .insert(orderMail)
      .values({
        ledgerPartyId: member.id,
        mailboxId: legacyMailbox ? `legacy:${member.id}` : "synthetic-mailbox",
        messageId: "synthetic-message",
        sender: "social@example.test",
        subject: content,
        receivedAt: new Date("2026-10-07T12:00:00Z"),
        rawChecksum: checksum,
        content: { snippet: content, bodyText: content, bodyHtml: null },
      })
      .returning();
    if (!source) throw new Error("Synthetic source unavailable");
    const createRun = () =>
      insertWithShortcode(ctx.db, "run", {
        purpose: "mail_import",
        status: "running",
        trigger: "manual",
        ledgerPartyId: member.id,
        actorUserId: ctx.actor.userId,
        actorName: member.name,
        actorEmail: "privacy@example.test",
        actorLedgerPartyShortcode: member.shortcode,
        actorLedgerPartyName: member.name,
        actorLedgerPartyKind: "member",
        input: {
          kind: "mail_research",
          mailboxId: source.mailboxId,
          sources: [{ orderMailId: source.id, checksum }],
        },
      });
    const owner = await createRun();
    const reader = await createRun();
    const [target] = await getDb(ctx.db)
      .insert(runTarget)
      .values({
        runId: owner.id,
        entityId: owner.id,
        entityKind: "run",
        workKey: source.id,
        state: "pending",
        targetFingerprint: checksum,
      })
      .returning();
    if (!target) throw new Error("Synthetic target unavailable");
    await getDb(ctx.db).insert(mailboxMessage).values({
      ledgerPartyId: member.id,
      mailboxId: source.mailboxId,
      messageId: source.messageId,
      checksum,
      classification: "related",
      classificationVersion: MAILBOX_RESEARCH_VERSION,
      status: "researching",
      runId: owner.id,
      orderMailId: source.id,
    });
    // Reading even a heading must retire this reader; it need not have retained evidence.
    await getDb(ctx.db).insert(researchSourceExposure).values({
      runId: reader.id,
      ledgerPartyId: member.id,
      orderMailId: source.id,
      checksum,
    });
    const proposal = researchWorkResolve.parse({
      workRef: target.id,
      status: "unrelated",
      identity: {
        evidenceIds: [],
        reasoning: "Unrelated synthetic social message",
      },
      orders: [],
      emailLinks: [],
      facts: [],
      detail: content,
    });
    const ports = {
      assess: async () => ({
        identityVerified: false,
        acceptedFacts: [],
        acceptedIdentifiers: [],
        acceptedIdentifierClaims: [],
        acceptedImages: [],
        acceptedOrders: [],
        acceptedEmailLinks: [],
        rejected: [],
      }),
    };
    return { member, source, owner, reader, target, proposal, ports, content };
  }

  it("keeps an unresolved historical ownership disposition from authorizing negative cleanup", async () => {
    const f = await fixture(true);
    await getDb(ctx.db)
      .update(mailboxMessage)
      .set({
        status: "blocked",
        classificationVersion: "legacy-source-identity-unresolved/v1",
      })
      .where(eq(mailboxMessage.orderMailId, f.source.id));
    await expect(
      resolveImportResearch(
        ctx.db,
        {
          runId: f.owner.id,
          workRef: f.target.id,
          callId: crypto.randomUUID(),
          proposal: f.proposal,
        },
        f.ports,
      ),
    ).rejects.toThrow(/historical.*ownership|original.*mapping/u);
    expect(await getDb(ctx.db).select().from(researchRetention)).toEqual([]);
    expect(await getDb(ctx.db).select().from(orderMail)).toEqual([f.source]);
  });

  it("fences the primary source and heading-only readers even without model-selected evidence", async () => {
    const f = await fixture();
    await resolveImportResearch(
      ctx.db,
      {
        runId: f.owner.id,
        workRef: f.target.id,
        callId: crypto.randomUUID(),
        proposal: f.proposal,
      },
      f.ports,
    );
    const receipts = await getDb(ctx.db).select().from(researchRetention);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      orderMailId: f.source.id,
      checksum: f.source.rawChecksum,
      phase: "fenced",
    });
    for (const id of [f.owner.id, f.reader.id]) {
      const [retired] = await getDb(ctx.db)
        .select()
        .from(run)
        .where(eq(run.id, id));
      expect(retired?.retiredAt).toBeInstanceOf(Date);
      expect(retired?.retirementReason).toBe("unrelated_source");
    }
  });

  it.each(["current", "historical", "alias"])(
    "refuses negative cleanup of an independently associated positive Purchase (source identity: %s)",
    async (identity) => {
      const f = await fixture(identity === "historical");
      const seller = await insertWithShortcode(ctx.db, "vendor", {
        name: "Synthetic protected seller",
      });
      const positive = await insertWithShortcode(ctx.db, "purchase", {
        vendorId: seller.id,
        orderId: "PROTECTED-ORDER",
      });
      let [claim] = await getDb(ctx.db)
        .insert(importSourceClaim)
        .values({
          ledgerPartyId: f.member.id,
          kind: "mail_message",
          externalKey:
            identity === "historical"
              ? `gmail:${f.source.messageId}:order:PROTECTED-ORDER`
              : identity === "alias"
                ? "synthetic:historical-message-original"
                : `gmail:${f.source.mailboxId}:${f.source.messageId}`,
          checksum: f.source.rawChecksum,
          firstRunId: f.owner.id,
          lastRunId: f.owner.id,
        })
        .returning();
      if (!claim) throw new Error("Synthetic association unavailable");
      if (identity !== "current") {
        const [root] = await getDb(ctx.db)
          .insert(importSourceClaim)
          .values({
            ledgerPartyId: f.member.id,
            kind: "mail_message",
            externalKey: `gmail:${f.source.mailboxId}:${f.source.messageId}`,
            checksum: f.source.rawChecksum,
            firstRunId: f.owner.id,
            lastRunId: f.owner.id,
          })
          .returning();
        if (!root) throw new Error("Synthetic canonical source unavailable");
        [claim] = await getDb(ctx.db)
          .update(importSourceClaim)
          .set({ canonicalClaimId: root.id })
          .where(eq(importSourceClaim.id, claim.id))
          .returning();
        if (!claim) throw new Error("Synthetic mapped source unavailable");
      }
      await getDb(ctx.db)
        .insert(importSourceOrder)
        .values({
          sourceClaimId: claim.id,
          orderKey: `${seller.id}/order/PROTECTED-ORDER`,
          purchaseId: positive.id,
          checksum: f.source.rawChecksum,
          outputFingerprint: "synthetic-positive",
        });
      await expect(
        resolveImportResearch(
          ctx.db,
          {
            runId: f.owner.id,
            workRef: f.target.id,
            callId: crypto.randomUUID(),
            proposal: f.proposal,
          },
          f.ports,
        ),
      ).rejects.toThrow(/positive|protect|associated/u);
      expect(await getDb(ctx.db).select().from(orderMail)).toHaveLength(1);
      expect(await getDb(ctx.db).select().from(importSourceOrder)).toHaveLength(
        1,
      );
      expect(await getDb(ctx.db).select().from(researchRetention)).toHaveLength(
        0,
      );
      expect(
        await getDb(ctx.db)
          .select()
          .from(importSourceClaim)
          .where(eq(importSourceClaim.id, claim.id)),
      ).toEqual([claim]);
    },
  );

  it("keeps deletion keys until acknowledgement and retries disposal before erasing disposable history", async () => {
    const f = await fixture();
    const objectKey = "synthetic-retention/original";
    await getDb(ctx.db)
      .insert(runEvidence)
      .values({
        runId: f.owner.id,
        targetId: f.target.id,
        kind: "mail_message",
        objectKey,
        checksum: f.source.rawChecksum,
        mediaType: "text/plain",
        sourceMetadata: { orderMailId: f.source.id, title: f.content },
      });
    await getDb(ctx.db)
      .insert(runOperation)
      .values({
        runId: f.reader.id,
        operationId: "synthetic-failed-proposal",
        kind: "research_resolve_import",
        inputFingerprint: f.source.rawChecksum,
        state: "failed",
        result: { attempt: { detail: f.content } },
        error: f.content,
      });
    const receipt = await requestResearchRetention(ctx.db, {
      runId: f.owner.id,
      workRef: f.target.id,
      callId: crypto.randomUUID(),
      hasSupportedWrites: false,
    });
    let failDelete = true;
    let failDisposal = true;
    const deleted: string[] = [];
    const ports = {
      deleteObject: async (key: string) => {
        if (failDelete) throw new Error("Synthetic storage unavailable");
        deleted.push(key);
      },
      retireCoordinator: async () => {
        if (failDisposal)
          throw new Error(
            "Synthetic isolate interrupted before deletion acknowledgement",
          );
        return { disposed: true };
      },
      forgetBrowserRun: async () => {},
      transferUnfinished: async () => [],
    };
    await expect(
      processResearchRetention(ctx.db, receipt.receiptId, ports),
    ).rejects.toThrow("Synthetic storage unavailable");
    let [pending] = await getDb(ctx.db).select().from(researchRetention);
    expect(pending?.phase).toBe("fenced");
    expect(pending?.plan.objectKeys).toEqual([objectKey]);
    failDelete = false;
    await expect(
      processResearchRetention(ctx.db, receipt.receiptId, ports),
    ).rejects.toThrow("Synthetic isolate interrupted");
    [pending] = await getDb(ctx.db).select().from(researchRetention);
    expect(pending?.phase).toBe("objects_deleted");
    expect(pending?.plan.objectKeys).toEqual([]);
    failDisposal = false;
    await processResearchRetention(ctx.db, receipt.receiptId, ports);
    await processResearchRetention(ctx.db, receipt.receiptId, ports);
    const [completed] = await getDb(ctx.db).select().from(researchRetention);
    expect(completed?.phase).toBe("completed");
    expect(deleted).toEqual([objectKey]);
    expect(await getDb(ctx.db).select().from(runOperation)).toHaveLength(0);
    expect(await getDb(ctx.db).select().from(runEvidence)).toHaveLength(0);
    expect(await getDb(ctx.db).select().from(orderMail)).toHaveLength(0);
  });

  it("locks the source before erasing retired Run history alongside late continuation", async () => {
    const f = await fixture();
    const receipt = await requestResearchRetention(ctx.db, {
      runId: f.owner.id,
      workRef: f.target.id,
      callId: "synthetic-erasure-lock-order",
      hasSupportedWrites: false,
    });
    let cleanup: Promise<unknown> | undefined;
    try {
      await withTransaction(ctx.db, async (tx) => {
        await tx
          .select()
          .from(orderMail)
          .where(eq(orderMail.id, f.source.id))
          .for("update");
        cleanup = processResearchRetention(ctx.db, receipt.receiptId, {
          deleteObject: async () => {},
          retireCoordinator: async () => ({ disposed: true }),
          forgetBrowserRun: async () => {},
          transferUnfinished: async () => [],
        });
        cleanup.catch(() => undefined);
        await expect
          .poll(
            async () => {
              await tx.execute(sql`select pg_stat_clear_snapshot()`);
              const waiting = await tx.execute(
                sql`select count(*)::integer as count from pg_stat_activity where pg_backend_pid() = any(pg_blocking_pids(pid))`,
              );
              return waiting.rows[0]?.count;
            },
            { timeout: 5000 },
          )
          .toBeGreaterThan(0);
        await tx
          .select()
          .from(run)
          .where(eq(run.id, f.owner.id))
          .for("update", { noWait: true });
      });
      await cleanup;
      const [completed] = await getDb(ctx.db)
        .select()
        .from(researchRetention)
        .where(eq(researchRetention.id, receipt.receiptId));
      expect(completed?.phase).toBe("completed");
    } finally {
      await cleanup;
    }
  });
  it("includes a heading reader's in-flight retained upload before acknowledging object deletion", async () => {
    const f = await fixture();
    const [target] = await getDb(ctx.db)
      .insert(runTarget)
      .values({
        runId: f.reader.id,
        entityId: f.reader.id,
        entityKind: "run",
        workKey: f.source.id,
        state: "pending",
        targetFingerprint: f.source.rawChecksum,
      })
      .returning();
    if (!target) throw new Error("Synthetic reader target unavailable");
    const objects = new Map<string, Uint8Array>();
    let enteredUpload = () => {};
    let releaseUpload = () => {};
    const entered = new Promise<void>((resolve) => {
      enteredUpload = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    const upload = retainResearchObservation(
      ctx.db,
      {
        runId: f.reader.id,
        workRef: target.id,
        callId: "synthetic-reader-upload",
        kind: "mail_message",
        sourceMetadata: {
          orderMailId: f.source.id,
          checksum: f.source.rawChecksum,
          title: f.content,
        },
        content: f.content,
      },
      {
        keyPrefix: "synthetic-retention-race",
        storage: {
          put: async (key, bytes) => {
            enteredUpload();
            await released;
            objects.set(key, bytes);
          },
        },
      },
    );
    upload.catch(() => undefined);
    await entered;
    const retiring = requestResearchRetention(ctx.db, {
      runId: f.owner.id,
      workRef: f.target.id,
      callId: "synthetic-retirement-during-upload",
      hasSupportedWrites: false,
    });
    retiring.catch(() => undefined);
    try {
      await expect
        .poll(
          async () => {
            const waiting = await getDb(ctx.db).execute(sql`
            SELECT count(*)::int AS count FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'
              AND query LIKE '%"Run"%'
          `);
            return waiting.rows[0]?.count;
          },
          { timeout: 5000 },
        )
        .toBeGreaterThan(0);
    } finally {
      releaseUpload();
      await Promise.allSettled([upload, retiring]);
    }
    const retained = await upload;
    const receipt = await retiring;
    const [evidence] = await getDb(ctx.db)
      .select()
      .from(runEvidence)
      .where(eq(runEvidence.id, retained.evidenceId));
    if (!evidence) throw new Error("Synthetic uploaded evidence unavailable");
    expect(objects.get(evidence.objectKey)).toEqual(
      new TextEncoder().encode(f.content),
    );
    await processResearchRetention(ctx.db, receipt.receiptId, {
      deleteObject: async (key) => {
        objects.delete(key);
      },
      retireCoordinator: async () => ({ disposed: true }),
      forgetBrowserRun: async () => {},
      transferUnfinished: async () => [],
    });
    const [completed] = await getDb(ctx.db).select().from(researchRetention);
    expect(completed?.phase).toBe("completed");
    expect(objects.has(evidence.objectKey)).toBe(false);
  });

  it("refuses a fresh coordinator's admission to a source already fenced by a cleanup receipt", async () => {
    const f = await fixture();
    await requestResearchRetention(ctx.db, {
      runId: f.owner.id,
      workRef: f.target.id,
      callId: crypto.randomUUID(),
      hasSupportedWrites: false,
    });
    const fresh = await insertWithShortcode(ctx.db, "run", {
      purpose: "mail_import",
      status: "running",
      trigger: "manual",
      ledgerPartyId: f.member.id,
      actorUserId: ctx.actor.userId,
      actorName: f.member.name,
      actorEmail: "privacy@example.test",
      actorLedgerPartyShortcode: f.member.shortcode,
      actorLedgerPartyName: f.member.name,
      actorLedgerPartyKind: "member",
      input: f.owner.input,
    });
    const [target] = await getDb(ctx.db)
      .insert(runTarget)
      .values({
        runId: fresh.id,
        entityId: fresh.id,
        entityKind: "run",
        workKey: f.source.id,
        state: "pending",
        targetFingerprint: f.source.rawChecksum,
      })
      .returning();
    if (!target) throw new Error("Synthetic fresh target unavailable");
    await expect(
      withResearchSourceAdmission(
        ctx.db,
        { runId: fresh.id, workRef: target.id },
        async () => ({ admitted: true }),
      ),
    ).rejects.toThrow(/retired/u);
  });

  it("preserves cancellation while erasing exposed history and never transfers canceled work", async () => {
    const f = await fixture();
    const canceledAt = new Date("2026-10-07T12:30:00Z");
    await getDb(ctx.db)
      .update(run)
      .set({
        status: "failed",
        failureCode: "user_cancelled",
        endedAt: canceledAt,
      })
      .where(eq(run.id, f.reader.id));
    const receipt = await requestResearchRetention(ctx.db, {
      runId: f.owner.id,
      workRef: f.target.id,
      callId: crypto.randomUUID(),
      hasSupportedWrites: false,
    });
    const [canceled] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.id, f.reader.id));
    expect(canceled).toMatchObject({
      status: "failed",
      failureCode: "user_cancelled",
      endedAt: canceledAt,
    });
    expect(canceled?.retiredAt).toBeInstanceOf(Date);
    const transferred: string[] = [];
    await processResearchRetention(ctx.db, receipt.receiptId, {
      deleteObject: async () => {},
      retireCoordinator: async () => ({ disposed: true }),
      forgetBrowserRun: async () => {},
      transferUnfinished: async ({ runId }) => {
        transferred.push(runId);
        return [];
      },
    });
    expect(transferred).toEqual([f.owner.id]);
    const [cleaned] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.id, f.reader.id));
    expect(cleaned).toMatchObject({
      status: "failed",
      failureCode: "user_cancelled",
      endedAt: canceledAt,
      input: null,
    });
  });

  it("does not transfer a retired reader that the member deleted before cleanup resumed", async () => {
    const f = await fixture();
    const receipt = await requestResearchRetention(ctx.db, {
      runId: f.owner.id,
      workRef: f.target.id,
      callId: crypto.randomUUID(),
      hasSupportedWrites: false,
    });
    await getDb(ctx.db)
      .update(run)
      .set({ deletedAt: new Date() })
      .where(eq(run.id, f.reader.id));
    const transferred: string[] = [];
    const result = await processResearchRetention(ctx.db, receipt.receiptId, {
      deleteObject: async () => {},
      retireCoordinator: async () => ({ disposed: true }),
      forgetBrowserRun: async () => {},
      transferUnfinished: async ({ runId }) => {
        transferred.push(runId);
        if (runId === f.reader.id)
          throw new Error("Deleted research cannot acquire a successor.");
        return [];
      },
    });
    expect(result).toEqual({ completed: true });
    expect(transferred).toEqual([f.owner.id]);
    const [deleted] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.id, f.reader.id));
    expect(deleted?.deletedAt).toBeInstanceOf(Date);
    expect(await getDb(ctx.db).select().from(orderMail)).toEqual([]);
  });

  it("retains only the human dismissal identity and checksum while erasing original mail date and generated event text", async () => {
    const f = await fixture();
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic dismissal seller",
    });
    const candidate = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      orderId: "SYNTHETIC-DISMISSED-CANDIDATE",
    });
    const [event] = await getDb(ctx.db)
      .insert(orderMailEvent)
      .values({
        orderMailId: f.source.id,
        event: "confirmation",
        sourceKey: f.content,
        orderId: f.content,
        payload: { reasoning: f.content },
        occurredAt: f.source.receivedAt,
      })
      .returning();
    if (!event) throw new Error("Synthetic dismissal event unavailable");
    const [decision] = await getDb(ctx.db)
      .insert(orderMailCandidateDecision)
      .values({
        eventId: event.id,
        purchaseId: candidate.id,
        decision: "dismissed",
        evidenceChecksum: f.source.rawChecksum,
        decidedByUserId: ctx.actor.userId,
      })
      .returning();
    const receipt = await requestResearchRetention(ctx.db, {
      runId: f.owner.id,
      workRef: f.target.id,
      callId: crypto.randomUUID(),
      hasSupportedWrites: false,
    });
    await processResearchRetention(ctx.db, receipt.receiptId, {
      deleteObject: async () => {},
      retireCoordinator: async () => ({ disposed: true }),
      forgetBrowserRun: async () => {},
      transferUnfinished: async () => [],
    });
    const [tombstone] = await getDb(ctx.db).select().from(orderMail);
    expect(tombstone).toMatchObject({
      id: f.source.id,
      rawChecksum: f.source.rawChecksum,
      sender: "",
      subject: "",
      receivedAt: null,
      content: { snippet: null, bodyText: null, bodyHtml: null },
    });
    const [retainedEvent] = await getDb(ctx.db).select().from(orderMailEvent);
    expect(JSON.stringify(retainedEvent)).not.toContain(f.content);
    const [retainedDecision] = await getDb(ctx.db)
      .select()
      .from(orderMailCandidateDecision);
    expect(retainedDecision).toEqual(decision);
  });

  it("preserves accepted source evidence and canonical facts while explicitly retiring contaminated rationale", async () => {
    const f = await fixture();
    const product = await insertWithShortcode(ctx.db, "product", {
      name: "Synthetic preserved item",
      manufacturer: "Synthetic preservation maker",
    });
    const positiveChecksum = await sha256Hex(
      "<h1>Synthetic preserved item</h1>",
    );
    const [positiveTarget] = await getDb(ctx.db)
      .insert(runTarget)
      .values({
        runId: f.reader.id,
        entityId: product.id,
        entityKind: "product",
        state: "completed",
        targetFingerprint: f.source.rawChecksum,
        outcome: "verified",
        warning: f.content,
      })
      .returning();
    const [evidence] = await getDb(ctx.db)
      .insert(runEvidence)
      .values({
        runId: f.reader.id,
        targetId: positiveTarget?.id,
        kind: "web_page",
        objectKey: "synthetic-retention/positive-source",
        checksum: positiveChecksum,
        mediaType: "text/html",
        sourceMetadata: { sourceURL: "https://retailer.example.test/item" },
      })
      .returning();
    if (!positiveTarget || !evidence)
      throw new Error("Synthetic accepted source unavailable");
    await getDb(ctx.db)
      .insert(runFactEvidence)
      .values({
        targetId: positiveTarget.id,
        entityKind: "product",
        entityId: product.id,
        evidenceId: evidence.id,
        fieldPath: "name",
        value: product.name,
        valueFingerprint: f.source.rawChecksum,
        support: { observation: f.content, reasoning: f.content },
      });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic positive mail seller",
    });
    const purchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      orderId: "SYNTHETIC-POSITIVE-ORDER",
    });
    const [positiveMail] = await getDb(ctx.db)
      .insert(orderMail)
      .values({
        ledgerPartyId: f.member.id,
        mailboxId: "synthetic-mailbox",
        messageId: "synthetic-positive-message",
        sender: "receipt@example.test",
        subject: "Synthetic accepted receipt",
        receivedAt: new Date("2026-10-06T12:00:00Z"),
        rawChecksum: positiveChecksum,
        content: {
          snippet: "Accepted receipt",
          bodyText: "Accepted receipt",
          bodyHtml: null,
        },
      })
      .returning();
    if (!positiveMail) throw new Error("Synthetic positive mail unavailable");
    const [positiveEvent] = await getDb(ctx.db)
      .insert(orderMailEvent)
      .values({
        orderMailId: positiveMail.id,
        event: "confirmation",
        sourceKey: purchase.id,
        orderId: purchase.orderId,
        payload: {
          researchRunId: f.reader.id,
          workRef: positiveTarget.id,
          proof: { reasoning: f.content },
        },
      })
      .returning();
    if (!positiveEvent) throw new Error("Synthetic positive event unavailable");
    const [positiveDecision] = await getDb(ctx.db)
      .insert(orderMailCandidateDecision)
      .values({
        eventId: positiveEvent.id,
        purchaseId: purchase.id,
        decision: "linked",
        evidenceChecksum: positiveChecksum,
        decidedByUserId: ctx.actor.userId,
      })
      .returning();
    const receipt = await requestResearchRetention(ctx.db, {
      runId: f.owner.id,
      workRef: f.target.id,
      callId: crypto.randomUUID(),
      hasSupportedWrites: false,
    });
    const deleted: string[] = [];
    await processResearchRetention(ctx.db, receipt.receiptId, {
      deleteObject: async (key) => {
        deleted.push(key);
      },
      retireCoordinator: async () => ({ disposed: true }),
      forgetBrowserRun: async () => {},
      transferUnfinished: async () => [],
    });
    expect(deleted).toEqual([]);
    const [preserved] = await getDb(ctx.db).select().from(runFactEvidence);
    expect(preserved).toMatchObject({
      evidenceId: evidence.id,
      value: product.name,
      support: null,
    });
    expect(preserved?.supportRetiredAt).toBeInstanceOf(Date);
    expect(await getDb(ctx.db).select().from(runEvidence)).toHaveLength(1);
    const [settled] = await getDb(ctx.db)
      .select()
      .from(runTarget)
      .where(eq(runTarget.id, positiveTarget.id));
    expect(settled).toMatchObject({
      state: "completed",
      outcome: "verified",
      warning: null,
    });
    const [retainedEvent] = await getDb(ctx.db)
      .select()
      .from(orderMailEvent)
      .where(eq(orderMailEvent.id, positiveEvent.id));
    expect(retainedEvent).toMatchObject({
      id: positiveEvent.id,
      orderMailId: positiveMail.id,
      orderId: purchase.orderId,
      payload: {
        researchRunId: f.reader.id,
        workRef: positiveTarget.id,
        supportRetiredAt: expect.any(String),
      },
    });
    expect(JSON.stringify(retainedEvent)).not.toContain(f.content);
    const [linked] = await getDb(ctx.db)
      .select()
      .from(orderMailCandidateDecision)
      .where(eq(orderMailCandidateDecision.eventId, positiveEvent.id));
    expect(linked).toEqual(positiveDecision);
    expect(await getDb(ctx.db).select().from(orderMail)).toHaveLength(1);
  });
});
