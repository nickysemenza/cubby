/** Member correction must retain only the exact reviewed original, preserve prediction
 * history and disposition, refuse authority/content races, and clean only new cache keys. */
import { runEntityId } from "@cubby/schemas/identifiers";
import { MAIL_ATTACHMENT_MAX_BYTES } from "@cubby/schemas/mailbox-research";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as choices from "~/server/ai/decision-model";
import { account } from "~/server/db/auth.schema";
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
} from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { ensureRun } from "~/server/runs/ensure-run";

import { productionOrderMailAttachmentStorage } from "./attachment-storage";
import { originalChecksum } from "./checksum";
import { normalizeMessage } from "./normalize";
import * as providers from "./provider";
import { correctEmailRelevance } from "./relevance-correction";
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
