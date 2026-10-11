/** Failures: selected Jev/Clef or relevance identity is lost, metadata leaks
 * between concurrent messages, rules claim a paid model, or known telemetry
 * is deduplicated against a historical unknown prediction. */
import * as models from "@cubby/shared/ai/models";
import { and, eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MAILBOX_TRIAGE_FEATURE,
  MAILBOX_RELEVANCE_FEATURE,
} from "~/server/ai/features";
import * as choices from "~/server/ai/jev";
import * as structured from "~/server/ai/run-feature";
import {
  emailClassificationObservation,
  email as emailTable,
} from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { ensureRun } from "~/server/runs/ensure-run";

import { syntheticMailImportRun } from "./execution.fixtures";
import { ingestGmailMessages } from "./ingest";
import { recordEmailClassificationObservation } from "./observations";
import type { GmailProvider } from "./types";
const storage = {
  put: async () => undefined,
  get: async () => new Uint8Array(),
  delete: async () => undefined,
};
const result = (selectedIndex: number) => ({
  selectedIndex,
  confidence: "high" as const,
  probability: 0.95,
  ranked: [],
});
describe("persisted production Gmail decision telemetry", () => {
  const ctx = withTestDb();
  afterEach(() => vi.restoreAllMocks());
  async function fixture(importPolicy = false) {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic decision member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const mailboxId = "synthetic-telemetry-mailbox";
    const runId = importPolicy
      ? await syntheticMailImportRun(ctx.db, ctx.actor, {
          ledgerPartyId: party.id,
          mailboxId,
        })
      : await ensureRun(ctx.db, ctx.actor, {
          purpose: "mail_discovery",
          status: "running",
          trigger: "manual",
          input: {
            mailboxId,
            scopedQueries: [],
            executionPolicy: "classification_only",
          },
        });
    const provider: GmailProvider = {
      getMessage: async (id) => ({
        id,
        payload: {
          mimeType: "text/plain",
          body: {
            data: Buffer.from(`Synthetic evidence ${id}`).toString("base64url"),
          },
        },
      }),
      getAttachment: async () => ({}),
      getProfile: async () => ({ historyId: "1" }),
      listHistory: async () => ({}),
      listMessages: async () => ({}),
    };
    return {
      party,
      runId,
      provider,
      input: { ledgerPartyId: party.id, mailboxId, runId, storage },
    };
  }
  it.each(["typesafe/jev", "@cf/cloudflare/clef"] as const)(
    "persists actual selected %s and prompt/operation through production ingestion",
    async (model) => {
      const f = await fixture();
      vi.spyOn(models, "selectDecisionModel").mockReturnValue(model);
      const runner = vi
        .spyOn(choices, "runJevChoice")
        .mockResolvedValue(result(1));
      await ingestGmailMessages(ctx.db, f.provider, {
        ...f.input,
        messageIds: ["selected-model"],
      });
      const [observation] = await getDb(ctx.db)
        .select()
        .from(emailClassificationObservation);
      expect(observation).toMatchObject({
        model,
        promptVersion: MAILBOX_TRIAGE_FEATURE.promptVersion,
        operation: "mailbox-triage",
        runId: f.runId,
        stage: "jev",
        classification: "unrelated",
        usageId: null,
      });
      expect(runner).toHaveBeenCalledWith(
        expect.objectContaining({
          decisionModel: model,
          usage: expect.objectContaining({
            runId: f.runId,
            operation: "mailbox-triage",
          }),
        }),
      );
    },
  );
  it("persists the actual relevance feature only after its authorized production call", async () => {
    const f = await fixture(true);
    vi.spyOn(models, "selectDecisionModel").mockReturnValue(
      "@cf/cloudflare/clef",
    );
    vi.spyOn(choices, "runJevChoice").mockResolvedValue(result(2));
    const relevance = vi
      .spyOn(structured, "runStructuredFeature")
      .mockResolvedValue({
        classification: "unrelated",
        reason: "Synthetic relevance verdict",
      });
    await ingestGmailMessages(ctx.db, f.provider, {
      ...f.input,
      messageIds: ["relevance-model"],
    });
    expect(relevance).toHaveBeenCalledWith(
      MAILBOX_RELEVANCE_FEATURE,
      expect.anything(),
      expect.objectContaining({
        runId: f.runId,
        operation: "mailbox-relevance",
      }),
    );
    expect(
      await getDb(ctx.db).select().from(emailClassificationObservation),
    ).toMatchObject([
      {
        model: MAILBOX_RELEVANCE_FEATURE.model,
        promptVersion: MAILBOX_RELEVANCE_FEATURE.promptVersion,
        operation: "mailbox-relevance",
        stage: "model",
        classification: "unrelated",
      },
    ]);
  });
  it("keeps incomplete-original rules and no-Run caller judgment telemetry unknown without model calls", async () => {
    const f = await fixture();
    const runner = vi.spyOn(choices, "runJevChoice");
    const relevance = vi.spyOn(structured, "runStructuredFeature");
    const provider = {
      ...f.provider,
      getMessage: async (id: string) => ({
        id,
        payload: {
          mimeType: "text/plain",
          body: { data: Buffer.from("x").toString("base64url"), size: 2 },
        },
      }),
    };
    await ingestGmailMessages(ctx.db, provider, {
      ...f.input,
      messageIds: ["incomplete-original-rule"],
    });
    await ingestGmailMessages(ctx.db, f.provider, {
      ...f.input,
      runId: undefined,
      callerJudges: true,
      messageIds: ["member-rule"],
    });
    expect(runner).not.toHaveBeenCalled();
    expect(relevance).not.toHaveBeenCalled();
    const observations = await getDb(ctx.db)
      .select()
      .from(emailClassificationObservation);
    expect(observations).toHaveLength(2);
    for (const observation of observations)
      expect(observation).toMatchObject({
        model: null,
        promptVersion: null,
        operation: null,
        stage: "rule",
      });
  });
  it("isolates actual model metadata while concurrent message decisions complete in reverse order", async () => {
    const f = await fixture();
    vi.spyOn(models, "selectDecisionModel")
      .mockReturnValueOnce("typesafe/jev")
      .mockReturnValueOnce("@cf/cloudflare/clef");
    let release: () => void = () => undefined;
    const delayed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner = vi
      .spyOn(choices, "runJevChoice")
      .mockImplementation(async (args) => {
        if (args.subject.includes("first-message")) await delayed;
        else release();
        return result(1);
      });
    await Promise.all([
      ingestGmailMessages(ctx.db, f.provider, {
        ...f.input,
        messageIds: ["first-message"],
      }),
      ingestGmailMessages(ctx.db, f.provider, {
        ...f.input,
        messageIds: ["second-message"],
      }),
    ]);
    const rows = await getDb(ctx.db)
      .select({
        messageId: emailTable.messageId,
        model: emailClassificationObservation.model,
      })
      .from(emailClassificationObservation)
      .innerJoin(
        emailTable,
        eq(emailTable.id, emailClassificationObservation.emailId),
      );
    for (const call of runner.mock.calls) {
      const id = call[0].subject.includes("first-message")
        ? "first-message"
        : "second-message";
      expect(rows.find((row) => row.messageId === id)?.model).toBe(
        call[0].decisionModel,
      );
    }
  });
  it("appends known metadata after historical unknown and deduplicates only exact prompt/model/operation", async () => {
    const f = await fixture();
    const email = await insertWithShortcode(ctx.db, "email", {
      ledgerPartyId: f.party.id,
      mailboxId: f.input.mailboxId,
      messageId: "historical-prediction",
      status: "pending",
      checksum: "a".repeat(64),
    });
    const prediction = {
      emailId: email.id,
      runId: f.runId,
      checksum: email.checksum,
      classification: "unrelated" as const,
      stage: "jev" as const,
      reason: "Synthetic unchanged verdict",
      classificationVersion: "synthetic-version",
    };
    await recordEmailClassificationObservation(ctx.db, prediction);
    const known = {
      ...prediction,
      model: "typesafe/jev",
      promptVersion: "synthetic-prompt-v1",
      operation: "mailbox-triage" as const,
    };
    await recordEmailClassificationObservation(ctx.db, known);
    await recordEmailClassificationObservation(ctx.db, known);
    await recordEmailClassificationObservation(ctx.db, {
      ...known,
      promptVersion: "synthetic-prompt-v2",
    });
    const rows = await getDb(ctx.db)
      .select()
      .from(emailClassificationObservation)
      .where(
        and(
          eq(emailClassificationObservation.emailId, email.id),
          eq(emailClassificationObservation.runId, f.runId),
        ),
      );
    expect(rows).toHaveLength(3);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          model: null,
          promptVersion: null,
          operation: null,
        }),
        expect.objectContaining({
          model: "typesafe/jev",
          promptVersion: "synthetic-prompt-v1",
          operation: "mailbox-triage",
        }),
        expect.objectContaining({ promptVersion: "synthetic-prompt-v2" }),
      ]),
    );
  });
});
