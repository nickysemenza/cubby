import { aiProvenance } from "@cubby/schemas/ai-evaluation";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  aiEvaluation,
  email,
  emailClassificationObservation,
} from "~/server/db/schema";
import { activateAiRefresh } from "~/server/repo/ai-refresh";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import {
  discoverAiRefresh,
  executeAiRefreshTarget,
} from "~/server/runs/ai-refresh";

import { originalChecksum } from "./checksum";
import { syntheticMailImportRun } from "./execution.fixtures";
import { normalizeMessage } from "./normalize";
import * as providers from "./provider";
import type { GmailMessage, GmailProvider } from "./types";

// Script only external Gmail/model ports; ownership, ledger and publication are real.
describe("Email prompt refresh publication", () => {
  const ctx = withTestDb();
  afterEach(() => vi.restoreAllMocks());
  it("reuses current triage, evaluates stale relevance and commits its receipt without transferring the source Run", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic refresh owner",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const mailboxId = "synthetic-authorized-refresh";
    await syntheticMailImportRun(ctx.db, ctx.actor, {
      ledgerPartyId: party.id,
      mailboxId,
    });
    const message: GmailMessage = {
      id: "synthetic-refresh-message",
      payload: {
        mimeType: "text/plain",
        headers: [{ name: "Subject", value: "Synthetic ambiguous notice" }],
        body: {
          data: Buffer.from(
            "A synthetic ambiguous notice with a reference",
          ).toString("base64url"),
        },
      },
    };
    const checksum = await originalChecksum(
      normalizeMessage(mailboxId, message),
    );
    const item = await insertWithShortcode(ctx.db, "email", {
      ledgerPartyId: party.id,
      mailboxId,
      messageId: message.id!,
      checksum,
      classification: "uncertain",
      classificationStage: "decision",
      classificationReason: "Synthetic ambiguity",
      status: "pending",
      executionPolicy: "classification_only",
    });
    const activation = await activateAiRefresh(
      ctx.db,
      "synthetic-email-current",
      { enabled: true },
    );
    await getDb(ctx.db)
      .insert(emailClassificationObservation)
      .values({
        emailId: item.id,
        checksum,
        classification: "uncertain",
        stage: "model",
        reason: "Synthetic prior prediction",
        provenance: aiProvenance.parse({
          dependencies: ["mailbox-triage", "mailbox-relevance"].map(
            (feature) => ({
              feature,
              ...activation.manifest[feature]!,
              generation:
                feature === "mailbox-triage"
                  ? activation.manifest[feature]!.generation
                  : 0,
            }),
          ),
          inputFingerprint: checksum,
          optionFingerprint: "",
          model: "typesafe/jev",
        }),
      });
    vi.spyOn(providers, "gmailProviderForUser").mockResolvedValue({
      getMessage: async () => message,
      getAttachment: async () => ({}),
      listMessages: async () => ({}),
      listHistory: async () => ({}),
      getProfile: async () => ({ historyId: "1" }),
    } satisfies GmailProvider);
    const triage = vi.fn(async () => "uncertain" as const);
    const relevance = vi.fn(async () => ({
      classification: "related" as const,
      reason: "Synthetic refreshed relevance",
    }));
    const ports = {
      emailPorts: {
        triage,
        relevance,
        storage: {
          put: async () => undefined,
          get: async () => new Uint8Array(),
          delete: async () => undefined,
        },
      },
    };
    await discoverAiRefresh(ctx.db);
    const [evaluation] = await getDb(ctx.db).select().from(aiEvaluation);
    expect(evaluation).toBeDefined();
    await executeAiRefreshTarget(ctx.db, evaluation!.id, ports);
    expect(triage).not.toHaveBeenCalled();
    expect(relevance).toHaveBeenCalledOnce();
    const [saved] = await getDb(ctx.db).select().from(aiEvaluation);
    expect(saved?.state).toBe("completed");
    expect(saved?.receipt).toMatchObject({ sourceChecksum: checksum });
    const [current] = await getDb(ctx.db)
      .select()
      .from(email)
      .where(eq(email.id, item.id));
    expect(current?.classification).toBe("related");
    expect(current?.runId).toBeNull();
    expect(
      (await getDb(ctx.db).select().from(emailClassificationObservation)).some(
        (row) => row.evaluationId === evaluation!.id,
      ),
    ).toBe(true);
    expect(await discoverAiRefresh(ctx.db)).toEqual([]);
  });
});
