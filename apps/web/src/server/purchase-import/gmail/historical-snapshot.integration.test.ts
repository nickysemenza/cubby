/** Historical known routing cannot disappear when a fresh prediction replaces it;
 * nullable original stage/reason remain unknown, and retries do not fabricate models. */
import * as models from "@cubby/shared/ai/models";
import { asc, eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as choices from "~/server/ai/jev";
import { emailClassificationObservation } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { ensureRun } from "~/server/runs/ensure-run";

import { ingestGmailMessages } from "./ingest";
import type { GmailProvider } from "./types";

describe("historical Gmail prediction preservation", () => {
  const ctx = withTestDb();
  afterEach(() => vi.restoreAllMocks());
  it("snapshots a known legacy prediction before the real selected model refresh and keeps both on retry", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic history member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const email = await insertWithShortcode(ctx.db, "email", {
      ledgerPartyId: party.id,
      provider: "gmail",
      mailboxId: "synthetic-history-mailbox",
      messageId: "synthetic-history-message",
      checksum: "a".repeat(64),
      classification: "related",
      classificationStage: null,
      classificationReason: null,
      classificationVersion: "synthetic-prior-version",
      status: "completed",
    });
    const runId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "mail_discovery",
      trigger: "manual",
      status: "running",
      input: {
        mailboxId: email.mailboxId,
        scopedQueries: [],
        executionPolicy: "classification_only",
      },
    });
    vi.spyOn(models, "selectDecisionModel").mockReturnValue(
      "@cf/cloudflare/clef",
    );
    vi.spyOn(choices, "runJevChoice").mockResolvedValue({
      selectedIndex: 1,
      confidence: "high",
      probability: 0.95,
      ranked: [],
    });
    const provider: GmailProvider = {
      getMessage: async (id) => ({
        id,
        payload: {
          mimeType: "text/plain",
          body: {
            data: Buffer.from("Synthetic fresh evidence").toString("base64url"),
          },
        },
      }),
      getAttachment: async () => ({}),
      getProfile: async () => ({ historyId: "1" }),
      listMessages: async () => ({}),
      listHistory: async () => ({}),
    };
    const input = {
      ledgerPartyId: party.id,
      mailboxId: email.mailboxId,
      messageIds: [email.messageId],
      runId,
      storage: {
        put: async () => undefined,
        get: async () => new Uint8Array(),
        delete: async () => undefined,
      },
    };
    await ingestGmailMessages(ctx.db, provider, input);
    const read = () =>
      getDb(ctx.db)
        .select()
        .from(emailClassificationObservation)
        .where(eq(emailClassificationObservation.emailId, email.id))
        .orderBy(asc(emailClassificationObservation.createdAt));
    const rows = await read();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      checksum: email.checksum,
      classification: "related",
      stage: null,
      reason: null,
      classificationVersion: email.classificationVersion,
      model: null,
      promptVersion: null,
      operation: null,
      usageId: null,
    });
    expect(rows[1]).toMatchObject({
      classification: "unrelated",
      stage: "jev",
      model: "@cf/cloudflare/clef",
      operation: "mailbox-triage",
    });
    const [prior, fresh] = rows;
    if (!prior || !fresh) throw new Error("Synthetic prediction rows missing");
    expect(prior.createdAt.getTime()).toBeLessThan(fresh.createdAt.getTime());
    await ingestGmailMessages(ctx.db, provider, input);
    expect(await read()).toEqual(rows);
  });
});
