import { aiProvenance, aiEvaluationTarget } from "@cubby/schemas/ai-evaluation";
import { discoveryEmailReceipt } from "@cubby/schemas/mailbox-research";
import { sql, eq } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it, vi } from "vitest";

import { activateAiRefresh } from "~/server/ai/repo/ai-refresh";
import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import {
  aiEvaluation,
  email,
  ledgerParty,
  emailClassificationObservation,
} from "~/server/db/schema";
import { ensureRun, systemActor } from "~/server/domains/run/repo/ensure-run";
import {
  drainAiEvaluations,
  withClaimedAiEvaluation,
} from "~/server/domains/run/service/ai-evaluation-drain.fixtures";
import { discoverAiRefresh } from "~/server/domains/run/service/ai-refresh";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import {
  assertEmailEvidenceScope,
  withEmailEvidenceWrite,
} from "../../repo/email-evidence-write-scope";
import { publishGmailEvidence } from "../../repo/gmail/admitted-source";
import { originalChecksum } from "../../repo/gmail/checksum";
import { normalizeMessage } from "../../repo/gmail/normalize";
import { recordEmailClassificationObservation } from "../../repo/gmail/observations";
import * as providers from "../../repo/gmail/provider";
import type { GmailMessage, GmailProvider } from "../../repo/gmail/types";
import { setMailImport } from "../../repo/mail-import-settings";
import { syntheticMailImportRun } from "./execution.fixtures";

// Script only external Gmail/model ports; ownership, ledger and publication are real.
describe("Email prompt refresh publication", () => {
  const ctx = withTestDb();
  const emailTarget = aiEvaluationTarget.options.find(
    (target) => target.shape.kind.value === "email",
  )!;
  afterEach(() => vi.restoreAllMocks());
  it("rolls back Email publication when activation is disabled and re-enabled during its callback", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic activation fence owner",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const mailboxId = "synthetic-activation-fence";
    await setMailImport(ctx.db, { mailboxId, enabled: true });
    const item = await insertWithShortcode(ctx.db, "email", {
      ledgerPartyId: party.id,
      mailboxId,
      messageId: "synthetic-activation-aba",
      checksum: "synthetic-checksum",
      classification: "uncertain",
      classificationStage: "decision",
      classificationReason: "Synthetic original",
      status: "pending",
      executionPolicy: "classification_only",
    });
    await activateAiRefresh(ctx.db, "synthetic-aba-enabled", { enabled: true });
    await discoverAiRefresh(ctx.db);
    const [evaluation] = await getDb(ctx.db)
      .select()
      .from(aiEvaluation)
      .where(sql`${aiEvaluation.target}->>'recordId' = ${item.id}`);
    expect(evaluation).toBeDefined();
    await expect(
      withClaimedAiEvaluation(ctx.db, evaluation!.id, (claimed) =>
        publishGmailEvidence(
          ctx.db,
          {
            ledgerPartyId: party.id,
            mailboxId,
            messageId: item.messageId,
            expected: item,
            executionPolicy: "classification_only",
            recordHandlingReceipt: false,
            evaluation: { id: evaluation!.id, token: claimed.attemptToken },
          },
          async (tx) => {
            await getDb(tx)
              .update(email)
              .set({ classificationReason: "Synthetic tentative change" })
              .where(eq(email.id, item.id));
            await activateAiRefresh(ctx.db, "synthetic-aba-disabled", {
              enabled: false,
            });
            await activateAiRefresh(ctx.db, "synthetic-aba-reenabled", {
              enabled: true,
            });
            return { synthetic: true };
          },
        ),
      ),
    ).rejects.toMatchObject({ cause: { code: "40001" } });
    expect(
      (await getDb(ctx.db).select().from(email).where(eq(email.id, item.id)))[0]
        ?.classificationReason,
    ).toBe("Synthetic original");
  });

  it("allows independent ordinary Gmail publications to commit under the shared outer scope", async () => {
    const parties = await Promise.all(
      ["Synthetic first mail owner", "Synthetic second mail owner"].map(
        (name, index) =>
          insertWithShortcode(ctx.db, "ledgerParty", {
            name,
            kind: "member",
            userId: index === 0 ? ctx.actor.userId : systemActor().userId,
          }),
      ),
    );
    const results = await Promise.allSettled(
      parties.map((party, index) =>
        publishGmailEvidence(
          ctx.db,
          {
            ledgerPartyId: party.id,
            mailboxId: `synthetic-independent-${index}`,
            messageId: "synthetic-independent-message",
            executionPolicy: "classification_only",
            expected: null,
            recordHandlingReceipt: false,
          },
          async (tx, _current, { scope }) => {
            assertEmailEvidenceScope(tx, scope);
            await getDb(tx).select({ id: email.id }).from(email);
            return insertWithShortcode(tx, "email", {
              ledgerPartyId: party.id,
              mailboxId: `synthetic-independent-${index}`,
              messageId: "synthetic-independent-message",
              checksum: "synthetic-independent-checksum",
              classification: "uncertain",
              status: "pending",
              executionPolicy: "classification_only",
            });
          },
        ),
      ),
    );
    expect(results.map((result) => result.status)).toEqual([
      "fulfilled",
      "fulfilled",
    ]);
    expect(
      await getDb(ctx.db).select({ id: email.id }).from(email),
    ).toHaveLength(2);
  });

  it("refuses an unscoped transaction and joins only a valid outer capability", async () => {
    const party = await createRepoEntity(ctx, "ledgerParty", {
      name: "Synthetic scoped publication",
      kind: "member",
    });
    const input = {
      ledgerPartyId: party.entityId,
      mailboxId: "synthetic-scoped-publication",
      messageId: "synthetic-scoped-message",
      executionPolicy: "classification_only",
      expected: null,
      recordHandlingReceipt: false,
    } as const;
    let calls = 0;
    await withTransactionDatabase(ctx.db, async (db) => {
      await expect(
        publishGmailEvidence(db, input, async () => {
          calls += 1;
          return true;
        }),
      ).rejects.toThrow("root Database");
    });
    expect(calls).toBe(0);
    await withEmailEvidenceWrite(ctx.db, async (db, scope) => {
      await expect(
        publishGmailEvidence(
          db,
          input,
          async (publicationDb, _current, { scope: inherited }) => {
            assertEmailEvidenceScope(publicationDb, inherited);
            expect(inherited).toBe(scope);
            calls += 1;
            return true;
          },
          scope,
        ),
      ).resolves.toBe(true);
    });
    expect(calls).toBe(1);
  });

  it("discards observation receipt metadata from an aborted publication attempt", async () => {
    const party = await createRepoEntity(ctx, "ledgerParty", {
      name: "Synthetic retry metadata",
      kind: "member",
    });
    await getDb(ctx.db)
      .update(ledgerParty)
      .set({ userId: ctx.actor.userId })
      .where(eq(ledgerParty.id, party.entityId));
    const ownerId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "mail_discovery",
      trigger: "manual",
      status: "running",
      input: {
        mailboxId: "synthetic-retry-metadata",
        scopedQueries: [],
        executionPolicy: "classification_only",
      },
    });
    const item = await insertWithShortcode(ctx.db, "email", {
      ledgerPartyId: party.entityId,
      mailboxId: "synthetic-retry-metadata",
      messageId: "synthetic-retry-message",
      checksum: "synthetic-current",
      classification: "uncertain",
      classificationStage: "decision",
      status: "pending",
    });
    const old = await recordEmailClassificationObservation(ctx.db, {
      emailId: item.id,
      checksum: item.checksum,
      classification: "related",
      stage: "decision",
      reason: "Synthetic retained prediction",
      classificationVersion: "synthetic",
    });
    let calls = 0;
    await expect(
      publishGmailEvidence(
        ctx.db,
        {
          ledgerPartyId: party.entityId,
          mailboxId: item.mailboxId,
          messageId: item.messageId,
          executionPolicy: "classification_only",
          expected: item,
          runId: ownerId,
        },
        async (_db, _current, publication) => {
          calls += 1;
          if (calls === 1) {
            publication.recordObservation(old.id);
            throw Object.assign(new Error("Synthetic aborted snapshot"), {
              code: "40001",
            });
          }
          return true;
        },
      ),
    ).resolves.toBe(true);
    expect(calls).toBe(2);
    const rows = await getDb(ctx.db).select().from(aiEvaluation);
    expect(rows).toHaveLength(1);
    expect(discoveryEmailReceipt.parse(rows[0]?.receipt)).toMatchObject({
      observationId: null,
      outcome: "reused",
      classification: "uncertain",
    });
  });

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
    const emailRefreshTarget = sql`${aiEvaluation.target}->>${emailTarget.keyof().enum.kind} = ${emailTarget.shape.kind.value}`;
    const [evaluation] = await getDb(ctx.db)
      .select()
      .from(aiEvaluation)
      .where(emailRefreshTarget);
    expect(evaluation).toBeDefined();
    await drainAiEvaluations(ctx.db, [evaluation!.id], ports);
    expect(triage).not.toHaveBeenCalled();
    expect(relevance).toHaveBeenCalledOnce();
    const [saved] = await getDb(ctx.db)
      .select()
      .from(aiEvaluation)
      .where(eq(aiEvaluation.id, evaluation!.id));
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
    expect((await discoverAiRefresh(ctx.db)).runs).not.toContain(
      evaluation!.runId,
    );
    expect(
      await getDb(ctx.db)
        .select({ id: aiEvaluation.id })
        .from(aiEvaluation)
        .where(emailRefreshTarget),
    ).toEqual([{ id: evaluation!.id }]);
  });
});
