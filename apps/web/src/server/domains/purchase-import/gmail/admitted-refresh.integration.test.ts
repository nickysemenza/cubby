/** Classifier-version refresh must not readmit or mutate admitted/stuck sources,
 * including provider removals; unassigned historical Email still refreshes. */
import { mailResearchRunInput } from "@cubby/schemas/run-fields";
import { eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";

import { getDb } from "~/server/db/helpers";
import {
  email as emailTable,
  orderMail,
  run,
  emailClassificationObservation,
} from "~/server/db/schema";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import { syntheticMailImportRun } from "./execution.fixtures";
import { ingestGmailMessages } from "./ingest";
import { GmailApiError, type GmailProvider } from "./types";

const storage = {
  put: async () => undefined,
  get: async () => new Uint8Array(),
  delete: async () => undefined,
};
const freshMessage = (id: string) => ({
  id,
  payload: {
    mimeType: "text/plain",
    body: {
      data: Buffer.from("Synthetic changed evidence").toString("base64url"),
    },
  },
});
const provider = (getMessage: GmailProvider["getMessage"]): GmailProvider => ({
  getMessage,
  getProfile: async () => ({ historyId: "100" }),
  listMessages: async () => ({}),
  listHistory: async () => ({}),
  getAttachment: async () => ({}),
});

describe("classification-only refresh of admitted Email", () => {
  const ctx = withTestDb();
  it.each([
    { status: "researching", label: "researching", ambiguous: false },
    { status: "blocked", label: "blocked", ambiguous: false },
    { status: "completed", label: "completed", ambiguous: false },
    { status: "blocked", label: "ambiguous historical", ambiguous: true },
  ] as const)(
    "preserves $label frozen original and Run ownership without classifier calls or saved dispatch",
    async ({ status, ambiguous }) => {
      const party = await insertWithShortcode(ctx.db, "ledgerParty", {
        name: "Synthetic frozen member",
        kind: "member",
        userId: ctx.actor.userId,
      });
      const mailboxId = "synthetic-frozen-mailbox";
      const messageId = "synthetic-frozen-message";
      const checksum = "a".repeat(64);
      const content = {
        bodyText: "Frozen synthetic original",
        bodyHtml: null,
        snippet: null,
        headers: {},
      };
      const legacy = await getDb(ctx.db).execute<{ column_name: string }>(
        sql`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='OrderMail' AND column_name='mailboxId'`,
      );
      if (legacy.rows.length)
        await getDb(ctx.db).execute(
          sql`INSERT INTO "OrderMail" ("ledgerPartyId", "mailboxId", "messageId", "rawChecksum", "content") VALUES (${party.id}, ${mailboxId}, ${messageId}, ${checksum}, ${JSON.stringify(content)}::jsonb)`,
        );
      else
        await getDb(ctx.db)
          .insert(orderMail)
          .values({ ledgerPartyId: party.id, rawChecksum: checksum, content });
      const [shell] = await getDb(ctx.db).select().from(orderMail);
      if (!shell) throw new Error("Synthetic frozen original missing");
      const importRunId = await syntheticMailImportRun(ctx.db, ctx.actor, {
        ledgerPartyId: party.id,
        mailboxId,
      });
      await getDb(ctx.db)
        .update(run)
        .set({
          input: mailResearchRunInput.parse({
            kind: "mail_research",
            sources: [
              {
                orderMailId: shell.id,
                checksum: ambiguous ? "b".repeat(64) : checksum,
              },
            ],
          }),
        })
        .where(eq(run.id, importRunId));
      const email = await insertWithShortcode(ctx.db, "email", {
        ledgerPartyId: party.id,
        provider: "gmail",
        mailboxId,
        messageId,
        orderMailId: shell.id,
        checksum,
        runId: importRunId,
        status,
        classification: "related",
        classificationVersion: "synthetic-old/v1",
      });
      const getMessage = vi.fn(async (id: string) => {
        if (ambiguous)
          throw new GmailApiError({
            message: "Synthetic provider 404",
            status: 404,
            reason: "notFound",
          });
        return freshMessage(id);
      });
      const triage = vi.fn(async () =>
        status === "completed"
          ? ("unrelated" as const)
          : ("uncertain" as const),
      );
      const relevance = vi.fn(async () => ({
        classification: "related" as const,
      }));
      const outcome = await ingestGmailMessages(ctx.db, provider(getMessage), {
        ledgerPartyId: party.id,
        mailboxId,
        messageIds: [messageId],
        triage,
        relevance,
        storage,
      });
      expect(outcome.saved).toEqual([]);
      expect(outcome.orderMailIds).toEqual([]);
      expect(triage).not.toHaveBeenCalled();
      expect(relevance).not.toHaveBeenCalled();
      expect(getMessage).not.toHaveBeenCalled();
      expect((await getDb(ctx.db).select().from(emailTable))[0]).toMatchObject({
        id: email.id,
        status,
        runId: importRunId,
        checksum,
        classification: "related",
        classificationVersion: "synthetic-old/v1",
        contentClearedAt: null,
      });
      expect((await getDb(ctx.db).select().from(orderMail))[0]).toMatchObject({
        id: shell.id,
        rawChecksum: checksum,
        content,
      });
      expect(
        await getDb(ctx.db).select().from(emailClassificationObservation),
      ).toEqual([]);
    },
  );
});
