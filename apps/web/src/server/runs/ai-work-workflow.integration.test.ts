import { mailReclassificationCheckpoint } from "@cubby/schemas/email-actions";
import { executionAuthorizationInput } from "@cubby/schemas/execution-authorization";
import { mailReclassifyRunInput } from "@cubby/schemas/run-fields";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { openWorkerdRuntime } from "tooling/workerd-runtime";
import { expect, it } from "vitest";

import { account } from "~/server/db/auth.schema";
import { aiEvaluation, run } from "~/server/db/schema";
import { prepareReclassification } from "~/server/purchase-import/gmail/reclassification-work";
import { HISTORICAL_MAIL_SOURCE_IDENTITY_VERSION } from "~/server/purchase-import/mail-source-identity";
import { requestedAiEvaluations } from "~/server/repo/ai-evaluation-requests";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { workflowInstanceId } from "~/server/workflow-runs/contract";

import { ensureRun } from "./ensure-run";
import { issueExecutionAuthorization } from "./execution-authorization";

const ctx = withTestDb();

// A real Workflow must survive waitForEvent's timeout, reclaim an interrupted
// target, publish its frozen receipt and finish. No provider or household data is needed.
it("continues an interrupted Email lease through the actual Workflow event-wait timeout", async () => {
  const party = await insertWithShortcode(ctx.db, "ledgerParty", {
    name: "Synthetic Workflow owner",
    kind: "member",
    userId: ctx.actor.userId,
  });
  const mailboxId = "synthetic-workflow-mailbox";
  await getDb(ctx.db).insert(account).values({
    id: crypto.randomUUID(),
    accountId: mailboxId,
    providerId: "google",
    userId: ctx.actor.userId,
    updatedAt: new Date(),
  });
  const authorization = await issueExecutionAuthorization(
    ctx.db,
    ctx.actor,
    executionAuthorizationInput.parse({
      kind: "execution_authorization",
      version: 1,
      owner: { userId: ctx.actor.userId, ledgerPartyId: party.id },
      scope: { kind: "backfill", mailboxId, discovery: "all_history" },
      meteredBudget: { period: "lifetime", limitMicroUSD: 1_000_000 },
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    }),
  );
  const selected = await insertWithShortcode(ctx.db, "email", {
    ledgerPartyId: party.id,
    mailboxId,
    messageId: "synthetic-frozen-workflow-message",
    checksum: "a".repeat(64),
    classification: "uncertain",
    classificationStage: "rule",
    classificationVersion: HISTORICAL_MAIL_SOURCE_IDENTITY_VERSION,
    executionPolicy: "classification_only",
    status: "blocked",
  });
  const id = await ensureRun(ctx.db, ctx.actor, {
    purpose: "mail_reclassify",
    trigger: "manual",
    input: mailReclassifyRunInput.parse({
      kind: "mail_reclassify",
      mode: "relevance",
      mailboxId,
      executionAuthorization: authorization,
      emails: [{ emailId: selected.id, checksum: selected.checksum }],
    }),
    progress: {
      kind: "mail_reclassification",
      version: 1,
      complete: false,
      results: [],
      attempt: 1,
    },
  });
  await prepareReclassification(ctx.db, id, [selected], authorization);
  const [owner] = await getDb(ctx.db).select().from(run).where(eq(run.id, id));
  const [item] = await requestedAiEvaluations(ctx.db, id);
  if (!owner || !item) throw new Error("Synthetic durable roster is missing");
  const { runtime } = await openWorkerdRuntime(
    { profile: "offline", database: { borrowed: ctx.databaseUrl } },
    async () => undefined,
  );
  try {
    const deadlineAt = new Date(Date.now() + 20_000);
    await getDb(ctx.db)
      .update(aiEvaluation)
      .set({
        state: "running",
        attemptToken: crypto.randomUUID(),
        attempts: 1,
        deadlineAt,
      })
      .where(eq(aiEvaluation.id, item.id));
    const env = await runtime.harness
      .getWorker<Pick<Env, "AI_REFRESH">>()
      .getEnv();
    const instance = await env.AI_REFRESH.create({
      id: workflowInstanceId(owner.shortcode, 1),
      params: { runId: id, attempt: 1 },
    });
    await expect
      .poll(
        async () => {
          const [current] = await getDb(ctx.db)
            .select()
            .from(run)
            .where(eq(run.id, id));
          return mailReclassificationCheckpoint.safeParse(current?.progress)
            .data?.automaticRecoveryFailures;
        },
        { timeout: 15_000 },
      )
      .toBe(0);
    expect(Date.now()).toBeLessThan(deadlineAt.getTime());
    expect((await requestedAiEvaluations(ctx.db, id))[0]?.state).toBe(
      "running",
    );
    await expect
      .poll(
        async () =>
          (await getDb(ctx.db).select().from(run).where(eq(run.id, id)))[0]
            ?.status,
        { timeout: 60_000 },
      )
      .toBe("completed");
    expect(
      (await requestedAiEvaluations(ctx.db, id))[0]?.receipt,
    ).toMatchObject({ result: { id: selected.shortcode, outcome: "frozen" } });
    await expect
      .poll(async () => (await instance.status()).status, { timeout: 10_000 })
      .toBe("complete");
  } finally {
    await runtime.close();
  }
}, 120_000);
