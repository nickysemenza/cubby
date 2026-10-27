import { parseEntityId } from "@cubby/schemas/identifiers";
import { workQueueHouseholdInput } from "@cubby/schemas/work-queue";
import { eq, sql } from "drizzle-orm";
import { createRepoIdentity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { getDb } from "~/server/db/helpers";
import {
  email,
  ledgerParty,
  orderMail,
  orderMailAttachment,
  run as runTable,
} from "~/server/db/schema";
import { emailScaffold } from "~/server/domains/email/repo/email";
import { resolveMail } from "~/server/domains/purchase-import/operations/mail-tool";
import { confirmEmailClassification } from "~/server/domains/purchase-import/repo/gmail/ingest-state";
import { recordEmailClassificationObservation } from "~/server/domains/purchase-import/repo/gmail/observations";
import {
  saveEmail,
  upsertOrderMail,
} from "~/server/domains/purchase-import/repo/gmail/persistence";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { recordFeedback } from "~/server/generic/assessment/repo/assessment";
import { ensureEmailAssessment } from "~/server/generic/assessment/repo/assessment-email";
import { listScaffold } from "~/server/generic/list/repo/list";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { readWorkQueue } from "~/server/generic/work-queue/service/work-queue-read";
import {
  derivedMarkTickets,
  drainStoredDerived,
} from "~/server/testing/background-queue";
import {
  storedQuality,
  storedQualityIds,
} from "~/server/testing/quality.fixtures";

import { emailChecks, EMAIL_QUALITY_RULES_VERSION } from "./checks/email";
import { loadDataQualities, loadQualityBreakdown } from "./hydrate";
import { gapCondition } from "./sql";

// Failure modes: original/import evidence crosses Email or member boundaries;
// filtered list counts and Work queue branches re-run live acceptance policy;
// reads publish repairs or source writes fail to enroll the quality family.
describe("Email data quality", () => {
  const ctx = withTestDb();
  const refresh = () => drainStoredDerived(ctx.db);

  it("loads original presence only for the scored Emails", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic content member",
      kind: "member",
    });
    const originals = await getDb(ctx.db)
      .insert(orderMail)
      .values(
        Array.from({ length: 7 }, (_, index) => ({
          ledgerPartyId: party.id,
          rawChecksum: "c".repeat(64),
          content: {
            snippet:
              index < 3 || index === 4 ? " " : "Synthetic retained content",
            bodyText:
              index === 1 ? "Synthetic plain text" : index === 2 ? " " : null,
            bodyHtml: index === 2 ? "<p>Synthetic HTML</p>" : null,
          },
        })),
      )
      .returning({ id: orderMail.id });
    const originalAt = (index: number) => {
      const original = originals[index];
      if (!original) throw new Error("Synthetic original missing");
      return original.id;
    };
    await getDb(ctx.db)
      .insert(orderMailAttachment)
      .values({
        orderMailId: originalAt(4),
        providerAttachmentId: "synthetic-retained",
        filename: "synthetic.pdf",
        mimeType: "application/pdf",
        checksum: "d".repeat(64),
        pendingObjectKey: "synthetic/retained.pdf",
      });
    const expectedMissing = new Set<string>();
    const ids: string[] = [];
    for (let index = 0; index < 7; index++) {
      const record = await insertWithShortcode(ctx.db, "email", {
        ledgerPartyId: party.id,
        mailboxId: "synthetic-content-mailbox",
        messageId: `synthetic-content-${index}`,
        checksum: "c".repeat(64),
        classification: index < 6 ? "related" : "unrelated",
        status: "pending",
        orderMailId: index === 3 ? null : originalAt(index),
        contentClearedAt: index === 5 ? new Date() : null,
      });
      ids.push(record.id);
      if (index === 0 || index === 3 || index === 5)
        expectedMissing.add(record.id);
    }
    const loaded = await emailChecks.evaluate(ctx.db, ids.slice(0, 6));
    expect(loaded.map((row) => row.id).sort()).toEqual(ids.slice(0, 6).sort());
    expect(
      new Set(
        loaded
          .filter((row) => row.checks.email_original_missing === "gap")
          .map((row) => row.id),
      ),
    ).toEqual(expectedMissing);
    expect(await emailChecks.evaluate(ctx.db, [])).toEqual([]);
  });

  it("counts and queues only Emails without a completed import", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic membership member",
      kind: "member",
    });
    const originals = await getDb(ctx.db)
      .insert(orderMail)
      .values(
        Array.from({ length: 4 }, () => ({
          ledgerPartyId: party.id,
          rawChecksum: "c".repeat(64),
        })),
      )
      .returning();
    const originalAt = (index: number) => {
      const original = originals[index];
      if (!original) throw new Error("Synthetic original was not created");
      return original.id;
    };
    for (let index = 0; index < 4; index++)
      await insertWithShortcode(ctx.db, "run", {
        ledgerPartyId: party.id,
        actorUserId: ctx.actor.userId,
        actorName: "Synthetic member",
        actorEmail: "member@example.test",
        actorLedgerPartyShortcode: party.shortcode,
        actorLedgerPartyName: party.name,
        actorLedgerPartyKind: party.kind,
        purpose: index < 2 ? "ai_suggest" : "mail_import",
        trigger: "manual",
        status: "completed",
        input: {
          kind: "mail_research",
          sources: [
            { orderMailId: originalAt(index % 2), checksum: "c".repeat(64) },
          ],
        },
      });
    for (let index = 0; index < 6; index++)
      await insertWithShortcode(ctx.db, "email", {
        ledgerPartyId: party.id,
        mailboxId: "synthetic-membership-mailbox",
        messageId: `synthetic-membership-${index}`,
        orderMailId:
          index % 3 === 0
            ? null
            : originalAt(Math.floor(index / 3) + (index % 3 === 1 ? 2 : 0)),
        checksum: "c".repeat(64),
        classification: "related",
        status: "pending",
      });
    await refresh();
    const statement = sql`SELECT "Email".id, ${gapCondition("email", "email_not_imported")} AS gap FROM ${email}`;
    const rows = await getDb(ctx.db).execute(statement);
    const gaps = z.array(z.object({ gap: z.boolean() })).parse(rows.rows);
    expect(gaps).toHaveLength(6);
    expect(gaps.filter((row) => row.gap)).toHaveLength(4);
    const plain = await listScaffold("email", email, {
      derived: {
        linkState: sql`0`,
        scopeLinkState: sql`NULL`,
        linked: sql`false`,
        reviewConflict: sql`false`,
        purchaseId: () => undefined,
        vendorId: () => undefined,
        vendorAccountId: () => undefined,
      },
    }).raw(
      ctx.db,
      {
        filters: {},
        sorts: [],
        pagination: { pageIndex: 0, pageSize: 25 },
        readIntent: "count",
        projection: [],
      },
      {},
    );
    expect(plain.count).toBe(6);
    const filtered = await emailScaffold.read(ctx.db, {
      filters: { dataGap: ["email_not_imported"] },
      sorts: [{ orderBy: "dataQuality", direction: "asc" }],
      pagination: { pageIndex: 0, pageSize: 25 },
      projection: ["dataQuality"],
    });
    expect(filtered.count).toBe(4);
    expect(filtered.data).toHaveLength(4);
    const count = await emailScaffold.read(ctx.db, {
      filters: { dataGap: ["email_not_imported"] },
      sorts: [],
      pagination: { pageIndex: 0, pageSize: 25 },
      projection: [],
      readIntent: "count",
    });
    expect(count.count).toBe(4);
    const facet = await emailScaffold.read(ctx.db, {
      filters: { dataStatus: ["needs_data"] },
      sorts: [],
      pagination: { pageIndex: 0, pageSize: 25 },
      projection: [],
      readIntent: "count",
    });
    expect(facet.count).toBe(6);
    const queue = await readWorkQueue(
      ctx.db,
      null,
      workQueueHouseholdInput.parse({
        reason: ["email_not_imported"],
        pageSize: 100,
      }),
      false,
    );
    expect(queue.meta.totalCount).toBe(4);
    expect(queue.items).toHaveLength(4);
    expect(queue.items.every((item) => item.entity === "email")).toBe(true);
  });

  it("enrolls mail inputs and retains publications across reads until refresh", async () => {
    const party = await createRepoIdentity(ctx, "ledgerParty", {
      name: "Synthetic publication member",
      kind: "member",
    });
    await getDb(ctx.db)
      .update(ledgerParty)
      .set({ userId: ctx.actor.userId })
      .where(eq(ledgerParty.id, party.entityId));
    const identity = {
      ledgerPartyId: party.entityId,
      mailboxId: "synthetic-publication-mailbox",
      messageId: "synthetic-publication",
    };
    const input = {
      ...identity,
      checksum: "e".repeat(64),
      classification: "related" as const,
      classificationStage: "decision" as const,
      status: "pending" as const,
    };
    await saveEmail(ctx.db, input);
    const [message] = await getDb(ctx.db)
      .select()
      .from(email)
      .where(eq(email.messageId, identity.messageId));
    if (!message) throw new Error("Synthetic Email missing");
    const emailId = parseEntityId("email", message.id);
    const published = async () =>
      (await loadDataQualities(ctx.db, "email", [emailId], "stored")).get(
        emailId,
      )!;
    expect((await published()).status).toBe("not_assessed");
    expect(
      (
        await loadQualityBreakdown(ctx.db, "email", message.shortcode)
      ).checks.map((check) => check.check),
    ).toContain("email_original_missing");
    expect(await storedQualityIds(ctx.db)).toEqual([]);
    await refresh();
    const stored = await storedQuality(ctx.db, message.id);
    expect(stored?.rulesVersion).toBe(EMAIL_QUALITY_RULES_VERSION);
    // A source write marks the Email's stored quality with a fresh ticket.
    const generation = async () =>
      Math.max(0, ...(await derivedMarkTickets(ctx.db, "email.dataQuality")));
    const enrolled = async <T>(write: () => Promise<T>) => {
      const before = await generation();
      const result = await write();
      expect(await generation()).toBeGreaterThan(before);
      return result;
    };
    const originalId = await enrolled(() =>
      upsertOrderMail(
        ctx.db,
        party.entityId,
        {
          ...identity,
          sourceKey: `gmail:${identity.mailboxId}:${identity.messageId}`,
          threadId: null,
          historyId: null,
          internalDate: null,
          labelIds: [],
          headers: {},
          snippet: "Synthetic retained original",
          bodyText: null,
          bodyHtml: null,
        },
        input.checksum,
      ),
    );
    expect((await published()).gaps.map((gap) => gap.check)).toContain(
      "email_original_missing",
    );
    expect(
      (await loadQualityBreakdown(ctx.db, "email", message.shortcode)).checks
        .filter((check) => check.state === "gap")
        .map((check) => check.check),
    ).not.toContain("email_original_missing");
    await refresh();
    expect((await published()).gaps.map((gap) => gap.check)).not.toContain(
      "email_original_missing",
    );
    await enrolled(() =>
      confirmEmailClassification(ctx.db, message.id, {
        stage: "model",
        reason: "Synthetic stage update",
      }),
    );
    const prediction = await enrolled(() =>
      recordEmailClassificationObservation(ctx.db, {
        emailId: message.id,
        checksum: input.checksum,
        classification: "related",
        stage: "model",
        reason: "Synthetic observed classification",
        classificationVersion: "synthetic-v1",
      }),
    );
    const assessment = await ensureEmailAssessment(ctx.db, prediction.id);
    await enrolled(() =>
      recordFeedback(ctx.db, {
        assessmentId: assessment.id,
        operationId: "synthetic-member-review",
        verdict: "correct",
        authority: "member",
        actorUserId: ctx.actor.userId,
        intent: "history",
        correction: { present: false },
      }),
    );
    await refresh();
    expect((await published()).gaps.map((gap) => gap.check)).not.toContain(
      "email_relevance_unreviewed",
    );
    await enrolled(() =>
      ensureRun(ctx.db, ctx.actor, {
        purpose: "mail_import",
        trigger: "manual",
        status: "completed",
        input: {
          kind: "mail_research",
          sources: [{ orderMailId: originalId, checksum: input.checksum }],
        },
      }),
    );
    expect((await published()).gaps.map((gap) => gap.check)).toContain(
      "email_not_imported",
    );
    await refresh();
    expect((await published()).gaps.map((gap) => gap.check)).not.toContain(
      "email_not_imported",
    );
  });

  it("rejects completed Mail import Runs without an owner", async () => {
    await expect(
      insertWithShortcode(ctx.db, "run", {
        ledgerPartyId: null,
        actorUserId: ctx.actor.userId,
        actorName: "Synthetic member",
        actorEmail: "member@example.test",
        purpose: "mail_import",
        trigger: "manual",
        status: "completed",
      }),
    ).rejects.toMatchObject({
      cause: { code: "23514", constraint: "Run_import_party_check" },
    });
  });

  // The historical JSON containment contract includes explicit JSON null,
  // ignores missing keys/scalars, and fences by live completed Run ownership.
  it("preserves source containment and completed-import fences", async () => {
    for (const scenario of [
      "exact",
      "extra-fields",
      "other-member",
      "failed",
      "deleted",
      "other-purpose",
      "scalar-sources",
      "missing-key",
      "explicit-null",
    ] as const) {
      const party = await insertWithShortcode(ctx.db, "ledgerParty", {
        name: `Synthetic ${scenario} member`,
        kind: "member",
      });
      const [original] = await getDb(ctx.db)
        .insert(orderMail)
        .values({ ledgerPartyId: party.id, rawChecksum: "c".repeat(64) })
        .returning();
      if (!original) throw new Error("Synthetic original was not created");
      const message = await insertWithShortcode(ctx.db, "email", {
        ledgerPartyId: party.id,
        mailboxId: "synthetic-containment-mailbox",
        messageId: scenario,
        checksum: "c".repeat(64),
        classification: "related",
        status: "pending",
        orderMailId:
          scenario === "explicit-null" || scenario === "missing-key"
            ? null
            : original.id,
      });
      const importParty =
        scenario === "other-member"
          ? await insertWithShortcode(ctx.db, "ledgerParty", {
              name: "Synthetic other importer",
              kind: "member",
            })
          : party;
      const run = await insertWithShortcode(ctx.db, "run", {
        ledgerPartyId: importParty.id,
        actorUserId: ctx.actor.userId,
        actorName: "Synthetic member",
        actorEmail: "member@example.test",
        actorLedgerPartyShortcode: importParty.shortcode,
        actorLedgerPartyName: importParty.name,
        actorLedgerPartyKind: importParty.kind,
        purpose: scenario === "other-purpose" ? "ai_suggest" : "mail_import",
        trigger: "manual",
        status: scenario === "failed" ? "failed" : "completed",
        deletedAt: scenario === "deleted" ? new Date() : null,
      });
      const source =
        scenario === "explicit-null"
          ? { orderMailId: null }
          : scenario === "missing-key"
            ? {}
            : {
                orderMailId: original.id,
                ...(scenario === "extra-fields"
                  ? { checksum: "synthetic-checksum" }
                  : {}),
              };
      // Malformed historical inputs bypass the current write schema on purpose.
      const input = {
        sources: scenario === "scalar-sources" ? source : [source],
      };
      await getDb(ctx.db).execute(
        sql`UPDATE ${runTable} SET input = ${JSON.stringify(input)}::jsonb WHERE id = ${run.id}`,
      );
      const [result] = await emailChecks.evaluate(ctx.db, [message.id]);
      const expected = ["exact", "extra-fields", "explicit-null"].includes(
        scenario,
      )
        ? "pass"
        : "gap";
      expect({ scenario, state: result?.checks.email_not_imported }).toEqual({
        scenario,
        state: expected,
      });
    }
  });

  it("settles automated negatives and keeps related checks bound to their own original and import", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic quality member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const shell = async (bodyText: string | null) =>
      (
        await getDb(ctx.db)
          .insert(orderMail)
          .values({
            ledgerPartyId: party.id,
            rawChecksum: "c".repeat(64),
            content: { snippet: null, bodyText, bodyHtml: null },
          })
          .returning()
      )[0]!;
    const email = (
      messageId: string,
      fields: Partial<
        Parameters<typeof insertWithShortcode<"email">>[2] & object
      >,
    ) =>
      insertWithShortcode(ctx.db, "email", {
        ledgerPartyId: party.id,
        provider: "gmail",
        mailboxId: "synthetic-quality-mailbox",
        messageId,
        checksum: "c".repeat(64),
        classification: "related",
        classificationStage: "decision",
        status: "pending",
        ...fields,
      });
    const other = await shell(null);
    await getDb(ctx.db)
      .insert(orderMailAttachment)
      .values({
        orderMailId: other.id,
        providerAttachmentId: "synthetic-other-attachment",
        filename: "other.pdf",
        mimeType: "application/pdf",
        checksum: "d".repeat(64),
        pendingObjectKey: "synthetic/other.pdf",
      });
    await insertWithShortcode(ctx.db, "run", {
      ledgerPartyId: party.id,
      actorUserId: ctx.actor.userId,
      actorName: "Synthetic member",
      actorEmail: "member@example.test",
      actorLedgerPartyShortcode: party.shortcode,
      actorLedgerPartyName: party.name,
      actorLedgerPartyKind: party.kind,
      purpose: "mail_import",
      trigger: "manual",
      status: "completed",
      input: {
        kind: "mail_research",
        sources: [{ orderMailId: other.id, checksum: "c".repeat(64) }],
      },
    });
    const unrelated = await email("synthetic-unrelated", {
      classification: "unrelated",
      status: "completed",
    });
    const emptyShell = await shell(null);
    const related = await email("synthetic-related", {
      orderMailId: emptyShell.id,
    });
    const retained = await email("synthetic-retained", {
      orderMailId: (await shell("Synthetic order body")).id,
    });
    const linked = await email("synthetic-linked", {
      orderMailId: (await shell("Synthetic existing-order confirmation")).id,
      classificationStage: "resolution",
      status: "completed",
    });
    const seller = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic existing-order vendor",
    });
    const order = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: seller.id,
      orderId: "synthetic-existing-order",
    });
    await resolveMail(
      ctx.db,
      {
        mailboxId: linked.mailboxId,
        messageId: linked.messageId,
        checksum: linked.checksum,
        disposition: {
          kind: "linked",
          event: "confirmation",
          purchaseIds: [order.shortcode],
        },
      },
      ctx.actor,
    );

    const id = (row: { id: string }) => parseEntityId("email", row.id);
    const qualities = await loadDataQualities(
      ctx.db,
      "email",
      [id(unrelated), id(related), id(retained), id(linked)],
      "live",
    );
    const gaps = (row: { id: string }) =>
      qualities
        .get(id(row))
        ?.gaps.map((gap) => gap.check)
        .sort();
    expect(gaps(unrelated)).toEqual(["email_display_image"]);
    expect(gaps(related)).toEqual([
      "email_display_image",
      "email_not_imported",
      "email_original_missing",
      "email_preview_missing",
      "email_relevance_unreviewed",
    ]);
    expect(gaps(retained)).toEqual([
      "email_display_image",
      "email_not_imported",
      "email_preview_missing",
      "email_relevance_unreviewed",
    ]);
    expect(gaps(linked)).toEqual(["email_display_image"]);

    await refresh();
    const reviewQueue = await emailScaffold.read(ctx.db, {
      filters: { dataGap: ["email_relevance_unreviewed"] },
      sorts: [],
      pagination: { pageIndex: 0, pageSize: 10 },
    });
    expect(reviewQueue.data.map((row) => row.id)).not.toContain(
      unrelated.shortcode,
    );

    const missingOriginal = await emailScaffold.read(ctx.db, {
      filters: { dataGap: ["email_original_missing"] },
      sorts: [],
      pagination: { pageIndex: 0, pageSize: 10 },
    });
    expect(missingOriginal.data.map((row) => row.id)).toEqual([
      related.shortcode,
    ]);
  });
});
