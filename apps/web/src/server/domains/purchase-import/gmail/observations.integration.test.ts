/** Predictions remain immutable after member labels; accepted content survives
 * contradictory predictions, and retrieval failures never invent classifications. */
import { eq } from "drizzle-orm";
import {
  listFeedbackByKind,
  seedEmailClassificationFeedback,
} from "tooling/shared-assessment-fixtures";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import {
  emailClassificationObservation,
  emailRetrievalFailure,
  email as emailTable,
  importSourceClaim,
  runFinding,
} from "~/server/db/schema";
import { readRetainedMail } from "~/server/domains/mail/repo/retained-mail";
import { ensureRun } from "~/server/domains/run/service/ensure-run";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import { importedPurchaseFixture } from "../import-run.fixtures";
import { ingestGmailMessages } from "./ingest";
import { GmailApiError, type GmailProvider } from "./types";
const storage = {
  put: async () => undefined,
  get: async () => new Uint8Array(),
  delete: async () => undefined,
};
const gmail: GmailProvider = {
  getProfile: async () => ({ historyId: "100" }),
  listMessages: async () => ({}),
  listHistory: async () => ({}),
  getAttachment: async () => ({}),
  getMessage: async (id) => ({
    id,
    payload: {
      mimeType: "text/plain",
      headers: [{ name: "Subject", value: "Synthetic evidence" }],
      body: { data: Buffer.from("Synthetic body").toString("base64url") },
    },
  }),
};
describe("immutable Email observations", () => {
  const ctx = withTestDb();
  it("persists prediction before a label and keeps raw retrieval failures separate", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const input = {
      ledgerPartyId: party.id,
      mailboxId: "synthetic-mailbox",
      messageIds: ["synthetic-message"],
      storage,
      triage: async () => "uncertain" as const,
    };
    await ingestGmailMessages(ctx.db, gmail, input);
    const [email] = await getDb(ctx.db).select().from(emailTable);
    const predictions = await getDb(ctx.db)
      .select()
      .from(emailClassificationObservation);
    expect(predictions).toHaveLength(1);
    const prediction = predictions[0];
    if (!email || !prediction) throw new Error("Synthetic prediction missing");
    expect(prediction).toMatchObject({
      emailId: email.id,
      classification: "uncertain",
      stage: "decision",
      checksum: email.checksum,
      runId: null,
      model: null,
      usageId: null,
      conflict: null,
    });
    await seedEmailClassificationFeedback(ctx.db, {
      predictionId: prediction.id,
      classification: "related",
      reason: "Synthetic member correction",
      actorUserId: ctx.actor.userId,
    });
    await ingestGmailMessages(ctx.db, gmail, input);
    expect(
      await getDb(ctx.db).select().from(emailClassificationObservation),
    ).toEqual(predictions);
    expect(
      await listFeedbackByKind(ctx.db, "email_classification_review"),
    ).toHaveLength(1);
    const raw = "404 Not Found: Synthetic upstream response";
    await ingestGmailMessages(
      ctx.db,
      {
        ...gmail,
        getMessage: async () => {
          throw new GmailApiError({ message: raw, status: 404 });
        },
      },
      input,
    );
    expect(
      await getDb(ctx.db).select().from(emailClassificationObservation),
    ).toEqual(predictions);
    expect(
      await getDb(ctx.db).select().from(emailRetrievalFailure),
    ).toMatchObject([
      { emailId: email.id, httpStatus: 404, error: raw, runId: null },
    ]);
  });
  it.each([false, true])(
    "records an accepted-unrelated conflict and preserves accepted bytes (Run: %s)",
    async (withRun) => {
      const fixture = await importedPurchaseFixture(ctx.db, ctx.actor);
      if (!fixture.association)
        throw new Error("Synthetic association missing");
      const input = {
        ledgerPartyId: fixture.party.id,
        mailboxId: "synthetic-mailbox",
        messageIds: ["accepted-message"],
        storage,
      };
      await ingestGmailMessages(ctx.db, gmail, {
        ...input,
        callerJudges: true,
      });
      const [original] = await readRetainedMail(ctx.db, {
        ledgerPartyIds: [fixture.party.id],
      });
      if (!original) throw new Error("Synthetic original missing");
      await getDb(ctx.db)
        .update(importSourceClaim)
        .set({
          externalKey: `gmail:${original.mailboxId}:${original.messageId}`,
          checksum: original.rawChecksum,
        })
        .where(eq(importSourceClaim.id, fixture.association.sourceClaimId));
      await getDb(ctx.db)
        .update(emailTable)
        .set({ classificationVersion: "synthetic-prior-version" })
        .where(eq(emailTable.messageId, "accepted-message"));
      const runId = withRun
        ? await ensureRun(ctx.db, ctx.actor, {
            purpose: "mail_discovery",
            trigger: "manual",
            status: "running",
            input: {
              mailboxId: input.mailboxId,
              scopedQueries: [],
              executionPolicy: "classification_only",
            },
          })
        : undefined;
      await ingestGmailMessages(ctx.db, gmail, {
        ...input,
        runId,
        triage: async () => "unrelated",
      });
      const [prediction] = await getDb(ctx.db)
        .select()
        .from(emailClassificationObservation)
        .where(eq(emailClassificationObservation.classification, "unrelated"));
      expect(prediction).toMatchObject({
        classification: "unrelated",
        conflict: { kind: "accepted_unrelated" },
      });
      const findings = await getDb(ctx.db).select().from(runFinding);
      expect(findings).toMatchObject(
        withRun
          ? [
              {
                runId,
                entityKind: "email",
                entityId: prediction?.emailId,
                kind: "other",
                status: "open",
              },
            ]
          : [],
      );
      expect(findings).toHaveLength(withRun ? 1 : 0);
      expect(
        await readRetainedMail(ctx.db, { ledgerPartyIds: [fixture.party.id] }),
      ).toEqual([original]);
      expect((await getDb(ctx.db).select().from(emailTable))[0]).toMatchObject({
        orderMailId: original.id,
        contentClearedAt: null,
      });
    },
  );
});
