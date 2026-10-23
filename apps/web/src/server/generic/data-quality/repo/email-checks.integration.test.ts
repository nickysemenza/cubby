import { parseEntityId } from "@cubby/schemas/identifiers";
import { workQueueHouseholdInput } from "@cubby/schemas/work-queue";
import { eq, sql } from "drizzle-orm";
import { createRepoIdentity } from "tooling/factories/repo";
import { countTestDbQueries, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { getDb } from "~/server/db/helpers";
import {
  email,
  entityQuality,
  job,
  ledgerParty,
  orderMail,
  orderMailAttachment,
  run as runTable,
} from "~/server/db/schema";
import { listEmailsRead } from "~/server/domains/email/repo/email";
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
import { invalidateRefreshFamily } from "~/server/generic/derived-refresh/repo/families";
import { advanceJob } from "~/server/generic/jobs/service/jobs";
import { listScaffold } from "~/server/generic/list/repo/list";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { readWorkQueue } from "~/server/generic/work-queue/service/work-queue-read";
import { refreshFamilyHandler } from "~/server/workflows/background-tasks/refresh-families";

import { emailChecks, EMAIL_QUALITY_RULES_VERSION } from "./checks/email";
import { loadDataQualities, loadQualityBreakdown } from "./hydrate";
import { gapCondition, qualityFilterSource, qualityFilterContext } from "./sql";

// Failure modes: original/import evidence crosses Email or member boundaries;
// filtered list counts and Work queue branches re-run live acceptance policy;
// reads publish repairs or source writes fail to enroll the quality family.
describe("Email data quality", () => {
  const ctx = withTestDb();
  const refresh = async () => {
    // Low-level historical fixtures deliberately bypass source writers.
    await invalidateRefreshFamily(ctx.db, "quality");
    for (let page = 0; page < 8; page++) {
      const [intent] = await getDb(ctx.db)
        .select()
        .from(job)
        .where(eq(job.key, "refresh:quality"));
      if (!intent) throw new Error("Expected quality refresh intent");
      expect(
        await advanceJob(ctx.db, intent.id, {
          "refresh.family": refreshFamilyHandler,
        }),
      ).toBe("succeeded");
      const [current] = await getDb(ctx.db)
        .select()
        .from(job)
        .where(eq(job.id, intent.id));
      if (current?.state === "completed") return;
    }
    throw new Error("Synthetic Email quality pass exceeded page budget");
  };

  it("batch-loads original presence only for the scored Emails", async () => {
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
    const loaded = await countTestDbQueries(() =>
      emailChecks.evaluate(ctx.db, ids.slice(0, 6)),
    );
    expect(loaded.queryCount).toBe(1);
    expect(loaded.result.map((row) => row.id).sort()).toEqual(
      ids.slice(0, 6).sort(),
    );
    expect(
      new Set(
        loaded.result
          .filter((row) => row.checks.email_original_missing === "gap")
          .map((row) => row.id),
      ),
    ).toEqual(expectedMissing);
    expect(loaded.statements.join("\n")).not.toContain('"content"');
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
    const statement = sql`SELECT "Email".id, ${gapCondition("email", "email_not_imported", undefined, qualityFilterContext("email"))} AS gap FROM ${qualityFilterSource("email")}`;
    const rows = await getDb(ctx.db).execute(statement);
    const gaps = z.array(z.object({ gap: z.boolean() })).parse(rows.rows);
    expect(gaps).toHaveLength(6);
    expect(gaps.filter((row) => row.gap)).toHaveLength(4);
    // Plain count reads need no completed-import membership or hydration.
    const plain = await countTestDbQueries(() =>
      listScaffold("email", email, {
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
        },
        {},
      ),
    );
    expect(plain.result.count).toBe(6);
    expect(plain.queryCount).toBe(1);
    expect(plain.statements.join("\n")).not.toMatch(/\bJOIN\b/i);
    const filtered = await countTestDbQueries(() =>
      listEmailsRead(
        ctx.db,
        { dataGap: ["email_not_imported"] },
        [{ orderBy: "dataQuality", direction: "asc" }],
        { pageIndex: 0, pageSize: 25 },
        { kind: "selected", fields: ["dataQuality"], groups: ["quality"] },
      ),
    );
    expect(filtered.result.count).toBe(4);
    expect(filtered.result.data).toHaveLength(4);
    const statements = filtered.statements.join("\n");
    expect(statements).toMatch(/JOIN[^;]*"EntityQuality"/i);
    expect(filtered.tables).toEqual(
      expect.arrayContaining(["EntityQuality", "EntityQualityCheck"]),
    );
    expect(
      filtered.tables.filter((table) =>
        [
          "ImportSourceClaim",
          "ImportSourceOrder",
          "EmailCandidateObservation",
          "AssessmentEmailLink",
          "Feedback",
          "Run",
        ].includes(table),
      ),
    ).toEqual([]);
    const count = await countTestDbQueries(() =>
      listEmailsRead(
        ctx.db,
        { dataGap: ["email_not_imported"] },
        [],
        { pageIndex: 0, pageSize: 25 },
        { kind: "selected", fields: [], groups: [] },
        "count",
      ),
    );
    expect(count.result.count).toBe(4);
    expect(count.queryCount).toBe(1);
    expect(count.tables).toEqual([
      "Email",
      "EntityQuality",
      "EntityQualityCheck",
    ]);
    const facet = await countTestDbQueries(() =>
      listEmailsRead(
        ctx.db,
        { dataStatus: ["needs_data"] },
        [],
        { pageIndex: 0, pageSize: 25 },
        { kind: "selected", fields: [], groups: [] },
        "count",
      ),
    );
    expect(facet.result.count).toBe(6);
    expect(facet.queryCount).toBe(1);
    expect(facet.tables).toEqual([
      "Email",
      "EntityQuality",
      "EntityQualityCheck",
    ]);
    const measuredQueue = await countTestDbQueries(() =>
      readWorkQueue(
        ctx.db,
        null,
        workQueueHouseholdInput.parse({
          check: ["email_not_imported"],
          pageSize: 100,
        }),
        false,
      ),
    );
    const queue = measuredQueue.result;
    expect(measuredQueue.tables).toContain("EntityQualityCheck");
    expect(
      measuredQueue.tables.filter((table) =>
        [
          "ImportSourceClaim",
          "ImportSourceOrder",
          "EmailCandidateObservation",
        ].includes(table),
      ),
    ).toEqual([]);
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
      (await loadDataQualities(ctx.db, "email", [emailId])).get(emailId)!;
    expect((await published()).status).toBe("not_assessed");
    expect(
      (
        await loadQualityBreakdown(ctx.db, "email", message.shortcode)
      ).checks.map((check) => check.check),
    ).toContain("email_original_missing");
    expect(await getDb(ctx.db).select().from(entityQuality)).toEqual([]);
    await refresh();
    const [stored] = await getDb(ctx.db)
      .select()
      .from(entityQuality)
      .where(eq(entityQuality.entityId, message.id));
    expect(stored?.rulesVersion).toBe(EMAIL_QUALITY_RULES_VERSION);
    const generation = async () =>
      (
        await getDb(ctx.db)
          .select()
          .from(job)
          .where(eq(job.key, "refresh:quality"))
      )[0]!.generation;
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
    const reviewQueue = await listEmailsRead(
      ctx.db,
      { dataGap: ["email_relevance_unreviewed"] },
      [],
      { pageIndex: 0, pageSize: 10 },
    );
    expect(reviewQueue.data.map((row) => row.id)).not.toContain(
      unrelated.shortcode,
    );

    const missingOriginal = await listEmailsRead(
      ctx.db,
      { dataGap: ["email_original_missing"] },
      [],
      { pageIndex: 0, pageSize: 10 },
    );
    expect(missingOriginal.data.map((row) => row.id)).toEqual([
      related.shortcode,
    ]);
  });
});
