/** Member correction must retain only the exact reviewed original, preserve prediction
 * history and disposition, refuse authority/content races, and clean only new cache keys. */
import { runEntityId } from "@cubby/schemas/identifiers";
import { MAIL_ATTACHMENT_MAX_BYTES } from "@cubby/schemas/mailbox-research";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as choices from "~/server/ai/decision-model";
import { withConnection } from "~/server/db";
import { account } from "~/server/db/auth.schema";
import {
  getDb,
  withTransaction,
  databaseForTransaction,
} from "~/server/db/helpers";
import {
  email as emailTable,
  emailClassificationObservation,
  emailRetrievalFailure,
  emailCandidateObservation,
  orderMail,
  orderMailAttachment,
  importSourceClaim,
  aiUsage,
  run,
  image,
  feedback,
  imageProcessingOrphan,
} from "~/server/db/schema";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { kernelCtx } from "~/server/domains/run/service/suggestion-sweep.fixtures";
import { ensureEmailAssessment } from "~/server/generic/assessment/repo/assessment-email";
import { reviewAssessment } from "~/server/generic/assessment/repo/assessment-review";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import { productionOrderMailAttachmentStorage } from "./attachment-storage";
import { originalChecksum } from "./checksum";
import { normalizeMessage } from "./normalize";
import { recordEmailClassificationObservation } from "./observations";
import * as providers from "./provider";
import {
  correctEmailRelevance,
  prepareEmailRelevanceCorrection,
  publishPreparedEmailRelevanceCorrection,
  discardPreparedEmailRelevanceCorrection,
  withEmailRelevancePreparation,
  EmailCorrectionCleanupError,
} from "./relevance-correction";
import { GmailApiError, type GmailMessage, type GmailProvider } from "./types";

const mailboxId = "synthetic-correction-mailbox";
const messageId = "synthetic-correction-message";
const pdf = Buffer.from("Synthetic reviewed attachment bytes");
describe("member-only exact original relevance correction", () => {
  const ctx = withTestDb();
  afterEach(() => vi.restoreAllMocks());
  async function fixture() {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic correction member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    await getDb(ctx.db).insert(account).values({
      id: crypto.randomUUID(),
      accountId: mailboxId,
      providerId: "google",
      userId: ctx.actor.userId,
      updatedAt: new Date(),
    });
    const email = await insertWithShortcode(ctx.db, "email", {
      ledgerPartyId: party.id,
      provider: "gmail",
      mailboxId,
      messageId,
      checksum: "a".repeat(64),
      classification: "unrelated",
      classificationStage: null,
      classificationReason: null,
      classificationVersion: "synthetic-history",
      status: "completed",
      contentClearedAt: new Date(),
      executionPolicy: "classification_only",
    });
    let message: GmailMessage = {
      id: messageId,
      payload: {
        mimeType: "multipart/mixed",
        parts: [
          {
            partId: "body",
            mimeType: "text/plain",
            body: {
              data: Buffer.from("Synthetic reviewed original body").toString(
                "base64url",
              ),
            },
          },
          {
            partId: "pdf",
            filename: "synthetic.pdf",
            mimeType: "application/pdf",
            body: { attachmentId: "synthetic-pdf", size: pdf.length },
          },
        ],
      },
    };
    const getMessage = vi.fn<GmailProvider["getMessage"]>(async () => message);
    const getAttachment = vi.fn<GmailProvider["getAttachment"]>(async () => ({
      data: pdf.toString("base64url"),
      size: pdf.length,
    }));
    const provider: GmailProvider = {
      getMessage,
      getAttachment,
      listMessages: async () => ({}),
      listHistory: async () => ({}),
      getProfile: async () => ({ historyId: "1" }),
    };
    const factory = vi
      .spyOn(providers, "gmailProviderForUser")
      .mockResolvedValue(provider);
    const objects = new Map<string, Uint8Array>();
    const put = vi
      .spyOn(productionOrderMailAttachmentStorage, "put")
      .mockImplementation(async (key, bytes) => {
        objects.set(key, bytes);
      });
    const remove = vi
      .spyOn(productionOrderMailAttachmentStorage, "delete")
      .mockImplementation(async (key) => {
        objects.delete(key);
      });
    const model = vi
      .spyOn(choices, "runDecisionChoice")
      .mockImplementation(async () => {
        throw new Error("Correction cannot invoke a model");
      });
    const expectedChanges: Partial<typeof emailTable.$inferSelect> = {};
    const input = {
      id: email.shortcode,
      expectedChecksum: email.checksum,
      reviewedChecksum: await originalChecksum(
        normalizeMessage(mailboxId, message),
      ),
      classification: "related" as const,
      reason: "Synthetic member reviewed this original",
    };
    return {
      email,
      expectedChanges,
      party,
      input,
      getMessage,
      getAttachment,
      factory,
      put,
      remove,
      objects,
      model,
      message: () => message,
      setMessage: (value: GmailMessage) => {
        message = value;
      },
    };
  }
  it("does not launder malformed provider attachment encoding into complete proof", async () => {
    const f = await fixture();
    f.getAttachment.mockResolvedValue({
      data: `${pdf.toString("base64url")}\n`,
      size: pdf.length,
    });
    await correctEmailRelevance(ctx.db, f.input, ctx.actor);
    const [resolution] = (
      await getDb(ctx.db).select().from(emailClassificationObservation)
    ).filter((row) => row.stage === "resolution");
    if (!resolution) throw new Error("Synthetic resolution missing");
    const published = await ensureEmailAssessment(ctx.db, resolution.id);
    expect(published.evidence).toMatchObject({
      originalCapture: {
        status: "incomplete",
        problem: { reason: "invalid_encoding" },
      },
    });
    expect(f.getAttachment).toHaveBeenCalledTimes(1);
  });
  async function sharedReviewFixture() {
    const f = await fixture();
    await getDb(ctx.db)
      .update(emailTable)
      .set({ checksum: f.input.reviewedChecksum })
      .where(eq(emailTable.id, f.email.id));
    const observation = await recordEmailClassificationObservation(ctx.db, {
      emailId: f.email.id,
      checksum: f.input.reviewedChecksum,
      classification: "related",
      stage: "decision",
      reason: "Synthetic reviewed prediction",
      classificationVersion: "synthetic",
      model: "typesafe/jev",
    });
    const prediction = await ensureEmailAssessment(ctx.db, observation.id);
    const review = {
      assessmentId: prediction.id,
      operationId: "synthetic-prepared-review",
      verdict: "wrong" as const,
      intent: "apply" as const,
      correction: { present: true as const, value: "uncertain" },
    };
    return { ...f, review };
  }
  async function replaceConnectedAccount() {
    await getDb(ctx.db).delete(account).where(eq(account.accountId, mailboxId));
    await getDb(ctx.db).insert(account).values({
      id: crypto.randomUUID(),
      accountId: mailboxId,
      providerId: "google",
      userId: ctx.actor.userId,
      updatedAt: new Date(),
    });
  }
  it("refuses a reconnected account incarnation visible after provider retrieval", async () => {
    const f = await fixture();
    const before = await evidence();
    f.getMessage.mockImplementationOnce(async () => {
      await replaceConnectedAccount();
      return f.message();
    });
    await expect(
      correctEmailRelevance(ctx.db, f.input, ctx.actor),
    ).rejects.toThrow("identity changed during retrieval");
    expect(await evidence()).toEqual(before);
    expect(f.put).not.toHaveBeenCalled();
  });
  it("refuses account replacement after staging and cleans only its unadopted bytes", async () => {
    const f = await fixture();
    const before = await evidence();
    const prepared = await prepareEmailRelevanceCorrection(
      ctx.db,
      f.input,
      ctx.actor,
    );
    await replaceConnectedAccount();
    await expect(
      withEmailRelevancePreparation(ctx.db, prepared, (value) =>
        withTransaction(ctx.db, (tx) =>
          publishPreparedEmailRelevanceCorrection(
            databaseForTransaction(tx),
            value,
            ctx.actor,
          ),
        ),
      ),
    ).rejects.toThrow("identity changed during retrieval");
    expect(await evidence()).toEqual(before);
    expect(f.objects.size).toBe(0);
  });
  it("preserves a prepared correction across credential refresh on the same account row", async () => {
    const f = await fixture();
    const prepared = await prepareEmailRelevanceCorrection(
      ctx.db,
      f.input,
      ctx.actor,
    );
    await getDb(ctx.db)
      .update(account)
      .set({
        accessToken: "synthetic-refreshed-access-token",
        updatedAt: new Date(),
      })
      .where(eq(account.accountId, mailboxId));
    await expect(
      withEmailRelevancePreparation(ctx.db, prepared, (value) =>
        withTransaction(ctx.db, (tx) =>
          publishPreparedEmailRelevanceCorrection(
            databaseForTransaction(tx),
            value,
            ctx.actor,
          ),
        ),
      ),
    ).resolves.toMatchObject({
      classification: "related",
      originalAvailable: true,
    });
    expect(f.objects.size).toBe(1);
    expect(f.getMessage).toHaveBeenCalledTimes(1);
  });
  it("retains command Feedback and raw retrieval failure when preparation fails", async () => {
    const f = await sharedReviewFixture();
    const [before] = await getDb(ctx.db)
      .select()
      .from(emailTable)
      .where(eq(emailTable.id, f.email.id));
    f.getMessage.mockRejectedValue(
      new GmailApiError({
        message: "Synthetic preparation unavailable",
        status: 503,
      }),
    );
    await expect(
      reviewAssessment(ctx.db, kernelCtx(ctx), f.review),
    ).rejects.toThrow("Synthetic preparation unavailable");
    const events = await getDb(ctx.db)
      .select()
      .from(feedback)
      .where(eq(feedback.assessmentId, f.review.assessmentId));
    expect(
      events.find((event) => event.operationId === f.review.operationId),
    ).toMatchObject({ intent: "apply", authority: "member", verdict: "wrong" });
    expect(
      events.find(
        (event) =>
          event.operationId === `command-application:${f.review.operationId}`,
      ),
    ).toBeUndefined();
    expect(
      (
        await getDb(ctx.db)
          .select()
          .from(emailTable)
          .where(eq(emailTable.id, f.email.id))
      )[0],
    ).toEqual(before);
    expect(await getDb(ctx.db).select().from(emailRetrievalFailure)).toEqual([
      expect.objectContaining({
        httpStatus: 503,
        error: "Synthetic preparation unavailable",
      }),
    ]);
    expect(f.put).not.toHaveBeenCalled();
  });
  it("replays a successful shared application without consulting an unavailable provider", async () => {
    const f = await sharedReviewFixture();
    const first = await reviewAssessment(ctx.db, kernelCtx(ctx), f.review);
    f.factory.mockRejectedValue(
      new Error("Synthetic provider unavailable after success"),
    );
    expect(await reviewAssessment(ctx.db, kernelCtx(ctx), f.review)).toEqual(
      first,
    );
    expect(f.factory).toHaveBeenCalledTimes(1);
    expect(f.getMessage).toHaveBeenCalledTimes(1);
    expect(f.put).toHaveBeenCalledTimes(1);
  });
  it("returns a concurrent canonical success when its own preparation fails", async () => {
    const f = await sharedReviewFixture();
    f.getMessage.mockImplementationOnce(async () => {
      await reviewAssessment(ctx.db, kernelCtx(ctx), f.review);
      throw new GmailApiError({
        message:
          "Synthetic first attempt retrieval failed after concurrent success",
        status: 503,
      });
    });
    expect(
      await reviewAssessment(ctx.db, kernelCtx(ctx), f.review),
    ).toMatchObject({ applied: true });
    expect(f.getMessage).toHaveBeenCalledTimes(2);
    expect(f.put).toHaveBeenCalledTimes(1);
    const events = await getDb(ctx.db)
      .select()
      .from(feedback)
      .where(eq(feedback.assessmentId, f.review.assessmentId));
    expect(
      events.filter(
        (event) =>
          event.operationId === `command-application:${f.review.operationId}`,
      ),
    ).toHaveLength(1);
    expect(
      await getDb(ctx.db).select().from(emailRetrievalFailure),
    ).toHaveLength(1);
  });
  it("does not hide failed preparation cleanup behind a concurrent successful receipt", async () => {
    const f = await sharedReviewFixture();
    f.remove.mockRejectedValue(
      new Error("Synthetic first attempt cleanup failed"),
    );
    f.put.mockImplementationOnce(async (key, bytes) => {
      f.objects.set(key, bytes);
      await reviewAssessment(ctx.db, kernelCtx(ctx), f.review);
      throw new Error("Synthetic first upload failed after concurrent success");
    });
    await expect(
      reviewAssessment(ctx.db, kernelCtx(ctx), f.review),
    ).rejects.toBeInstanceOf(EmailCorrectionCleanupError);
    const events = await getDb(ctx.db)
      .select()
      .from(feedback)
      .where(eq(feedback.assessmentId, f.review.assessmentId));
    expect(
      events.filter(
        (event) =>
          event.operationId === `command-application:${f.review.operationId}`,
      ),
    ).toHaveLength(1);
    expect(
      await getDb(ctx.db).select().from(imageProcessingOrphan),
    ).toHaveLength(1);
    expect(f.objects.size).toBe(2);
    expect(
      (
        await getDb(ctx.db)
          .select()
          .from(emailTable)
          .where(eq(emailTable.id, f.email.id))
      )[0]?.classificationStage,
    ).toBe("resolution");
  });
  it("keeps verified preparation content module-private and its identity immutable", async () => {
    const f = await fixture();
    const prepared = await prepareEmailRelevanceCorrection(
      ctx.db,
      f.input,
      ctx.actor,
    );
    expect("details" in prepared).toBe(false);
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(() =>
      Object.defineProperty(prepared, "emailId", {
        value: "synthetic-other-owner",
      }),
    ).toThrow(/not extensible/u);
    expect(JSON.stringify(prepared)).toBe("{}");
    // A reachable JS constructor must not register caller-provided proof.
    const reconstructed: Awaited<
      ReturnType<typeof prepareEmailRelevanceCorrection>
    > = Reflect.construct(prepared.constructor, [
      {
        input: f.input,
        actorUserId: ctx.actor.userId,
        email: f.email,
        normalized: normalizeMessage(mailboxId, f.message()),
        checksum: f.input.reviewedChecksum,
        uploads: new Map(),
      },
    ]);
    await expect(
      withTransaction(ctx.db, (tx) =>
        publishPreparedEmailRelevanceCorrection(
          databaseForTransaction(tx),
          reconstructed,
          ctx.actor,
        ),
      ),
    ).rejects.toThrow("preparation authority does not match");
    await withTransaction(ctx.db, (tx) =>
      publishPreparedEmailRelevanceCorrection(
        databaseForTransaction(tx),
        prepared,
        ctx.actor,
      ),
    );
    expect(
      (await getDb(ctx.db).select().from(orderMail))[0]?.content,
    ).toMatchObject({ bodyText: "Synthetic reviewed original body" });
  });
  it("serializes every deletion and attempts failed keys on a single-connection root", async () => {
    const f = await fixture();
    const original = f.message();
    const payload = original.payload;
    if (!payload?.parts)
      throw new Error("Synthetic multipart original missing");
    const changed: GmailMessage = {
      ...original,
      payload: {
        ...payload,
        parts: [
          ...payload.parts,
          {
            partId: "second-pdf",
            mimeType: "application/pdf",
            filename: "second-synthetic.pdf",
            body: {
              attachmentId: "second-synthetic-attachment",
              size: pdf.length,
            },
          },
        ],
      },
    };
    f.setMessage(changed);
    const input = {
      ...f.input,
      reviewedChecksum: await originalChecksum(
        normalizeMessage(mailboxId, changed),
      ),
    };
    let active = 0;
    let maximum = 0;
    let attempted = 0;
    f.remove.mockImplementation(async () => {
      attempted += 1;
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      throw new Error("Synthetic per-key cleanup failure");
    });
    await withConnection(ctx.db, async (single) => {
      const prepared = await prepareEmailRelevanceCorrection(
        single,
        input,
        ctx.actor,
      );
      await expect(
        discardPreparedEmailRelevanceCorrection(single, prepared),
      ).rejects.toBeInstanceOf(EmailCorrectionCleanupError);
    });
    expect(attempted).toBe(2);
    expect(maximum).toBe(1);
    expect(
      await getDb(ctx.db).select().from(imageProcessingOrphan),
    ).toHaveLength(2);
  });
  it("publishes prepared evidence with provider and storage PUT tripwires", async () => {
    const f = await fixture();
    const prepared = await prepareEmailRelevanceCorrection(
      ctx.db,
      f.input,
      ctx.actor,
    );
    f.getMessage.mockRejectedValue(
      new Error("Unexpected publication provider IO"),
    );
    f.getAttachment.mockRejectedValue(
      new Error("Unexpected publication attachment IO"),
    );
    f.put.mockRejectedValue(new Error("Unexpected publication storage IO"));
    await withTransaction(ctx.db, (tx) =>
      publishPreparedEmailRelevanceCorrection(
        databaseForTransaction(tx),
        prepared,
        ctx.actor,
      ),
    );
    await discardPreparedEmailRelevanceCorrection(ctx.db, prepared);
    expect(f.getMessage).toHaveBeenCalledTimes(1);
    expect(f.getAttachment).toHaveBeenCalledTimes(1);
    expect(f.put).toHaveBeenCalledTimes(1);
    expect(f.remove).not.toHaveBeenCalled();
    expect(f.objects.size).toBe(1);
  });
  it("refuses cleaned preparations without recreating their objects or routing", async () => {
    const f = await fixture();
    const prepared = await prepareEmailRelevanceCorrection(
      ctx.db,
      f.input,
      ctx.actor,
    );
    await discardPreparedEmailRelevanceCorrection(ctx.db, prepared);
    expect(f.objects.size).toBe(0);
    const before = await evidence();
    await expect(
      withTransaction(ctx.db, (tx) =>
        publishPreparedEmailRelevanceCorrection(
          databaseForTransaction(tx),
          prepared,
          ctx.actor,
        ),
      ),
    ).rejects.toThrow("reservation expired");
    expect(await evidence()).toEqual(before);
    expect(f.put).toHaveBeenCalledTimes(1);
    expect(f.objects.size).toBe(0);
  });
  it("rolls back publication and discards only unadopted staged bytes", async () => {
    const f = await fixture();
    const before = await evidence();
    const prepared = await prepareEmailRelevanceCorrection(
      ctx.db,
      f.input,
      ctx.actor,
    );
    await expect(
      withEmailRelevancePreparation(ctx.db, prepared, (prepared) =>
        withTransaction(ctx.db, async (tx) => {
          await publishPreparedEmailRelevanceCorrection(
            databaseForTransaction(tx),
            prepared,
            ctx.actor,
          );
          throw new Error("Synthetic caller receipt failure");
        }),
      ),
    ).rejects.toThrow("Synthetic caller receipt failure");
    expect(await evidence()).toEqual(before);
    expect(f.objects.size).toBe(0);
  });
  it("applies a domain-supported relevance correction through shared review", async () => {
    const f = await fixture();
    await getDb(ctx.db)
      .update(emailTable)
      .set({ checksum: f.input.reviewedChecksum })
      .where(eq(emailTable.id, f.email.id));
    const observation = await recordEmailClassificationObservation(ctx.db, {
      emailId: f.email.id,
      checksum: f.input.reviewedChecksum,
      classification: "related",
      stage: "decision",
      reason: "Synthetic reviewed prediction",
      classificationVersion: "synthetic",
      model: "typesafe/jev",
    });
    const prediction = await ensureEmailAssessment(ctx.db, observation.id);
    expect(
      await reviewAssessment(ctx.db, kernelCtx(ctx), {
        assessmentId: prediction.id,
        operationId: "synthetic-valid-relevance",
        verdict: "wrong",
        intent: "apply",
        correction: { present: true, value: "uncertain" },
      }),
    ).toMatchObject({ applied: true });
    const [stored] = await getDb(ctx.db)
      .select()
      .from(emailTable)
      .where(eq(emailTable.id, f.email.id));
    expect(stored).toMatchObject({
      checksum: f.input.reviewedChecksum,
      classification: "uncertain",
      classificationStage: "resolution",
    });
    expect(f.getMessage).toHaveBeenCalledTimes(1);
    expect(f.model).not.toHaveBeenCalled();
  });
  async function configureContentFailure(
    f: Awaited<ReturnType<typeof fixture>>,
    input: Awaited<ReturnType<typeof fixture>>["input"],
    failure: string,
  ) {
    if (failure === "changed_id")
      f.setMessage({ ...f.message(), id: "different-synthetic-message" });
    if (failure === "spam")
      f.setMessage({ ...f.message(), labelIds: ["SPAM"] });
    if (failure === "unavailable") f.setMessage({ id: messageId });
    if (failure === "oversize_body")
      f.setMessage({
        id: messageId,
        payload: {
          mimeType: "text/plain",
          body: {
            data: Buffer.from(
              "x".repeat(MAIL_ATTACHMENT_MAX_BYTES + 1),
            ).toString("base64url"),
          },
        },
      });
    if (failure === "aggregate_body")
      f.setMessage({
        id: messageId,
        payload: {
          mimeType: "multipart/alternative",
          parts: ["text/plain", "text/html"].map((mimeType) => ({
            mimeType,
            body: {
              data: Buffer.from("x".repeat(2 * 1024 * 1024)).toString(
                "base64url",
              ),
            },
          })),
        },
      });
    if (
      failure === "oversize_attachment" ||
      failure === "aggregate_attachments"
    ) {
      const size =
        failure === "oversize_attachment"
          ? MAIL_ATTACHMENT_MAX_BYTES + 1
          : 2 * 1024 * 1024;
      f.setMessage({
        id: messageId,
        payload: {
          mimeType: "multipart/mixed",
          parts: Array.from(
            { length: failure === "oversize_attachment" ? 1 : 2 },
            (_, index) => ({
              partId: `part-${index}`,
              filename: `synthetic-${index}.pdf`,
              mimeType: "application/pdf",
              body: { attachmentId: `synthetic-${index}`, size },
            }),
          ),
        },
      });
      f.getAttachment.mockResolvedValue({
        data: Buffer.alloc(size).toString("base64url"),
        size,
      });
    }
    if (
      [
        "oversize_body",
        "aggregate_body",
        "oversize_attachment",
        "aggregate_attachments",
        "unavailable",
      ].includes(failure)
    )
      input = {
        ...input,
        reviewedChecksum: await originalChecksum(
          normalizeMessage(mailboxId, f.message()),
        ),
      };
    if (failure === "changed_attachment_size")
      f.getAttachment.mockResolvedValue({
        data: Buffer.from("wrong").toString("base64url"),
        size: pdf.length,
      });
    if (failure === "checksum_changes_during_fetch") {
      f.expectedChanges.checksum = "c".repeat(64);
      f.getMessage.mockImplementation(async () => {
        const [changed] = await getDb(ctx.db)
          .update(emailTable)
          .set({ checksum: "c".repeat(64) })
          .where(eq(emailTable.id, f.email.id))
          .returning({ updatedAt: emailTable.updatedAt });
        if (!changed) throw new Error("Synthetic checksum race Email missing");
        f.expectedChanges.updatedAt = changed.updatedAt;
        return f.message();
      });
    }
    if (failure === "owner_transfers_during_fetch") {
      const foreign = await insertWithShortcode(ctx.db, "ledgerParty", {
        name: "Synthetic transferred member",
        kind: "member",
      });
      f.expectedChanges.ledgerPartyId = foreign.id;
      f.getMessage.mockImplementation(async () => {
        const [changed] = await getDb(ctx.db)
          .update(emailTable)
          .set({ ledgerPartyId: foreign.id })
          .where(eq(emailTable.id, f.email.id))
          .returning({ updatedAt: emailTable.updatedAt });
        if (!changed) throw new Error("Synthetic ownership race Email missing");
        f.expectedChanges.updatedAt = changed.updatedAt;
        return f.message();
      });
    }
    if (failure === "account_removed_during_fetch")
      f.getMessage.mockImplementation(async () => {
        await getDb(ctx.db)
          .delete(account)
          .where(eq(account.accountId, mailboxId));
        return f.message();
      });
    return input;
  }
  async function evidence() {
    return {
      emails: await getDb(ctx.db).select().from(emailTable),
      predictions: await getDb(ctx.db)
        .select()
        .from(emailClassificationObservation),
      originals: await getDb(ctx.db).select().from(orderMail),
      attachments: await getDb(ctx.db).select().from(orderMailAttachment),
      candidates: await getDb(ctx.db).select().from(emailCandidateObservation),
      claims: await getDb(ctx.db).select().from(importSourceClaim),
      usage: await getDb(ctx.db).select().from(aiUsage),
      runs: await getDb(ctx.db).select().from(run),
    };
  }
  it.each(["related", "uncertain"] as const)(
    "retains the reviewed discarded original with %s resolution without admission",
    async (classification) => {
      const f = await fixture();
      expect(
        await correctEmailRelevance(
          ctx.db,
          { ...f.input, classification },
          ctx.actor,
        ),
      ).toEqual({
        id: f.email.shortcode,
        checksum: f.input.reviewedChecksum,
        classification,
        originalAvailable: true,
      });
      const after = await evidence();
      expect(after.emails).toHaveLength(1);
      expect(after.emails[0]).toMatchObject({
        classification,
        classificationStage: "resolution",
        classificationReason: f.input.reason,
        checksum: f.input.reviewedChecksum,
        status: "completed",
        runId: null,
        contentClearedAt: null,
      });
      expect(after.originals).toHaveLength(1);
      expect(after.originals[0]).toMatchObject({
        rawChecksum: f.input.reviewedChecksum,
        content: { bodyText: "Synthetic reviewed original body" },
      });
      const resolution = after.predictions.find(
        (prediction) => prediction.stage === "resolution",
      );
      if (!resolution) throw new Error("Synthetic resolution missing");
      expect(
        (await ensureEmailAssessment(ctx.db, resolution.id)).evidence,
      ).toMatchObject({
        originalCapture: {
          status: "complete",
          binding: {
            ledgerPartyId: f.email.ledgerPartyId,
            mailboxId,
            messageId,
          },
        },
      });
      expect(after.predictions).toHaveLength(2);
      expect(after.predictions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            classification: "unrelated",
            checksum: f.email.checksum,
            stage: null,
            reason: null,
            model: null,
          }),
          expect.objectContaining({
            classification,
            stage: "resolution",
            reason: f.input.reason,
            model: null,
            promptVersion: null,
            operation: null,
            usageId: null,
          }),
        ]),
      );
      expect(after.attachments).toHaveLength(1);
      const attachment = after.attachments[0];
      if (!attachment?.pendingObjectKey)
        throw new Error("Synthetic correction cache missing");
      expect(
        Array.from(f.objects.get(attachment.pendingObjectKey) ?? []),
      ).toEqual(Array.from(pdf));
      expect(after.candidates).toEqual([]);
      expect(after.claims).toEqual([]);
      expect(after.usage).toEqual([]);
      expect(after.runs).toEqual([]);
      expect(f.model).not.toHaveBeenCalled();
      expect(f.remove).not.toHaveBeenCalled();
    },
  );
  it.each([
    "stale_expected",
    "stale_reviewed",
    "foreign_owner",
    "disconnected_account",
    "actor_run",
    "frozen_assignment",
    "ambiguous_assignment",
    "changed_id",
    "spam",
    "unavailable",
    "oversize_body",
    "aggregate_body",
    "oversize_attachment",
    "aggregate_attachments",
    "changed_attachment_size",
    "checksum_changes_during_fetch",
    "owner_transfers_during_fetch",
    "account_removed_during_fetch",
  ] as const)(
    "refuses %s without retaining content or replacing prediction",
    async (failure) => {
      const f = await fixture();
      let input = f.input;
      let actor = ctx.actor;
      if (failure === "stale_expected")
        input = { ...input, expectedChecksum: "b".repeat(64) };
      if (failure === "stale_reviewed")
        input = { ...input, reviewedChecksum: "b".repeat(64) };
      if (failure === "foreign_owner")
        await getDb(ctx.db)
          .update(emailTable)
          .set({
            ledgerPartyId: (
              await insertWithShortcode(ctx.db, "ledgerParty", {
                name: "Synthetic foreign member",
                kind: "member",
              })
            ).id,
          })
          .where(eq(emailTable.id, f.email.id));
      if (failure === "disconnected_account")
        await getDb(ctx.db)
          .delete(account)
          .where(eq(account.accountId, mailboxId));
      if (failure === "actor_run")
        actor = { ...actor, runId: runEntityId.parse(crypto.randomUUID()) };
      if (
        failure === "frozen_assignment" ||
        failure === "ambiguous_assignment"
      ) {
        const [shell] = await getDb(ctx.db)
          .insert(orderMail)
          .values({
            ledgerPartyId: f.party.id,
            rawChecksum: f.email.checksum,
            content: {
              snippet: null,
              bodyText: "Synthetic frozen accepted evidence",
              bodyHtml: null,
            },
          })
          .returning();
        if (!shell) throw new Error("Synthetic frozen shell missing");
        const runId = await ensureRun(ctx.db, ctx.actor, {
          purpose: "mail_import",
          trigger: "manual",
          status: "running",
          input: {
            kind: "mail_research",
            sources: [
              {
                orderMailId: shell.id,
                checksum:
                  failure === "frozen_assignment"
                    ? f.email.checksum
                    : "b".repeat(64),
              },
            ],
          },
        });
        await getDb(ctx.db)
          .update(emailTable)
          .set({
            runId: runEntityId.parse(runId),
            orderMailId: shell.id,
            status: "blocked",
          })
          .where(eq(emailTable.id, f.email.id));
      }
      input = await configureContentFailure(f, input, failure);
      const before = await evidence();
      await expect(correctEmailRelevance(ctx.db, input, actor)).rejects.toThrow(
        /Email|member|Run|checksum|original|attachment|size|bound|excluded|bytes|account/iu,
      );
      const after = await evidence();
      const expectedEmails = before.emails.map((row) =>
        row.id === f.email.id ? { ...row, ...f.expectedChanges } : row,
      );
      expect(after.emails).toEqual(expectedEmails);
      expect(after.predictions).toEqual(before.predictions);
      expect(after.originals).toEqual(before.originals);
      expect(after.attachments).toEqual(before.attachments);
      expect(after.candidates).toEqual(before.candidates);
      expect(after.claims).toEqual(before.claims);
      expect(f.put).not.toHaveBeenCalled();
      expect(f.model).not.toHaveBeenCalled();
      const fetchAllowed = ![
        "stale_expected",
        "foreign_owner",
        "disconnected_account",
        "actor_run",
        "frozen_assignment",
        "ambiguous_assignment",
      ].includes(failure);
      expect(f.factory.mock.calls.length).toBe(fetchAllowed ? 1 : 0);
    },
  );
  it("retains only raw provider failure while leaving known routing/checksum/header history unchanged", async () => {
    const f = await fixture();
    const before = await evidence();
    const diagnostic = 'Gmail 404 {"error":"Synthetic missing original"}';
    f.getMessage.mockRejectedValue(
      new GmailApiError({ status: 404, message: diagnostic }),
    );
    await expect(
      correctEmailRelevance(ctx.db, f.input, ctx.actor),
    ).rejects.toThrow(diagnostic);
    expect(await evidence()).toEqual(before);
    expect(
      await getDb(ctx.db).select().from(emailRetrievalFailure),
    ).toMatchObject([
      { emailId: f.email.id, httpStatus: 404, error: diagnostic },
    ]);
  });
  it("rolls back failed cache retention and removes only newly created objects while preserving existing promoted media", async () => {
    const f = await fixture();
    const normalized = normalizeMessage(mailboxId, f.message());
    const existingPart = normalized.attachments[0];
    if (!existingPart) throw new Error("Synthetic promoted descriptor missing");
    const [shell] = await getDb(ctx.db)
      .insert(orderMail)
      .values({
        ledgerPartyId: f.party.id,
        rawChecksum: f.email.checksum,
        content: { snippet: null, bodyText: null, bodyHtml: null },
      })
      .returning();
    if (!shell) throw new Error("Synthetic correction shell missing");
    await getDb(ctx.db)
      .update(emailTable)
      .set({ orderMailId: shell.id })
      .where(eq(emailTable.id, f.email.id));
    const promoted = await insertWithShortcode(ctx.db, "image", {
      key: "synthetic-promoted-original",
      filename: "synthetic.pdf",
      size: pdf.length,
      contentType: "application/pdf",
      status: "UPLOADED",
      sha256: "d".repeat(64),
    });
    await getDb(ctx.db)
      .insert(orderMailAttachment)
      .values({
        orderMailId: shell.id,
        providerAttachmentId: existingPart.sourceKey,
        filename: existingPart.filename,
        mimeType: existingPart.mimeType,
        checksum: "d".repeat(64),
        pendingObjectKey: "synthetic-existing-cache",
        imageId: promoted.id,
      });
    f.objects.set("synthetic-existing-cache", new Uint8Array(pdf));
    f.objects.set("synthetic-promoted-original", new Uint8Array(pdf));
    const oldMessage = f.message();
    f.setMessage({
      ...oldMessage,
      payload: {
        ...oldMessage.payload,
        parts: [
          ...(oldMessage.payload?.parts ?? []),
          ...["new-a", "new-b"].map((id) => ({
            partId: id,
            filename: `synthetic-${id}.pdf`,
            mimeType: "application/pdf",
            body: { attachmentId: id, size: pdf.length },
          })),
        ],
      },
    });
    const input = {
      ...f.input,
      reviewedChecksum: await originalChecksum(
        normalizeMessage(mailboxId, f.message()),
      ),
    };
    const before = await evidence();
    const storedKeys: string[] = [];
    f.put.mockImplementation(async (key, bytes) => {
      storedKeys.push(key);
      f.objects.set(key, bytes);
      if (storedKeys.length === 2)
        throw new Error("Synthetic object write failure");
    });
    await expect(
      correctEmailRelevance(ctx.db, input, ctx.actor),
    ).rejects.toThrow("Synthetic object write failure");
    expect(await evidence()).toEqual(before);
    expect(await getDb(ctx.db).select().from(image)).toEqual([promoted]);
    expect(storedKeys).toHaveLength(2);
    expect([...f.objects.keys()].sort()).toEqual([
      "synthetic-existing-cache",
      "synthetic-promoted-original",
    ]);
    expect(f.remove.mock.calls.map(([key]) => key).sort()).toEqual(
      storedKeys.sort(),
    );
  });
});
