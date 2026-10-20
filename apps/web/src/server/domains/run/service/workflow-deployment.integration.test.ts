import { mailReclassificationCheckpoint } from "@cubby/schemas/email-actions";
import { mailReclassifyRunInput } from "@cubby/schemas/run-fields";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { openWorkerdRuntime } from "tooling/workerd-runtime";
import { expect, it } from "vitest";

import { requestedAiEvaluations } from "~/server/ai/repo/ai-evaluation-requests";
import { account } from "~/server/db/auth.schema";
import { getDb } from "~/server/db/helpers";
import { aiEvaluation, run } from "~/server/db/schema";
import { prepareReclassification } from "~/server/domains/purchase-import/repo/gmail/reclassification-work";
import { HISTORICAL_MAIL_SOURCE_IDENTITY_VERSION } from "~/server/domains/purchase-import/repo/mail-source-identity";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import {
  activateWorkflowDeployment,
  WORKFLOW_CONTROL_EVENT,
} from "~/server/workflows/runs/activation";
import { workflowInstanceId } from "~/server/workflows/runs/contract";

import { ensureRun } from "../repo/ensure-run";

const ctx = withTestDb();

// Ordinary deployment cutover must wake a durable wait, retain paid work, and
// resume through the current queue consumer without failing the Run.
it("adopts a deploy control event during a durable wait and resumes retained work", async () => {
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
  await prepareReclassification(ctx.db, id, [selected]);
  const [owner] = await getDb(ctx.db).select().from(run).where(eq(run.id, id));
  const [item] = await requestedAiEvaluations(ctx.db, id);
  if (!owner || !item) throw new Error("Synthetic durable roster is missing");
  const { runtime } = await openWorkerdRuntime(
    {
      profile: "coupled",
      database: { borrowed: ctx.databaseUrl },
    },
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
      .getWorker<Pick<Env, "AI_REFRESH" | "AI_GATEWAY_EGRESS">>()
      .getEnv();
    // Miniflare's Node metadata is a different UUID. Seed this synthetic
    // activation from a runtime binding; production activation uses provider IDs.
    const workerVersion = await env.AI_GATEWAY_EGRESS.getByName(
      "synthetic-workflow-runtime-version",
    ).currentDeploymentVersion();
    await activateWorkflowDeployment(ctx.db, {
      deploymentId: "synthetic-workflow-initial",
      workerVersion,
      expectedEpoch: 0,
    });
    const instance = await env.AI_REFRESH.create({
      id: workflowInstanceId(owner.shortcode, 1),
      params: {
        runId: id,
        attempt: 1,
        deploymentVersion: workerVersion,
        activationEpoch: 1,
      },
    });
    try {
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
    } catch (error) {
      throw new Error(
        JSON.stringify({
          status: await instance.status(),
          version: workerVersion,
          owner: (
            await getDb(ctx.db)
              .select({
                progress: run.progress,
                failureCode: run.failureCode,
                error: run.dispatchError,
              })
              .from(run)
              .where(eq(run.id, id))
          )[0],
        }),
        { cause: error },
      );
    }
    expect(Date.now()).toBeLessThan(deadlineAt.getTime());
    expect((await requestedAiEvaluations(ctx.db, id))[0]?.state).toBe(
      "running",
    );
    const adoptDeployment = async () => {
      await activateWorkflowDeployment(ctx.db, {
        deploymentId: "synthetic-workflow-replacement",
        workerVersion: "synthetic-obsolete-version",
        expectedEpoch: 1,
      });
      await instance.sendEvent({ type: WORKFLOW_CONTROL_EVENT, payload: {} });
      await expect
        .poll(async () => (await instance.status()).status, {
          timeout: 10_000,
        })
        .toBe("complete");
      expect((await requestedAiEvaluations(ctx.db, id))[0]?.state).toBe(
        "running",
      );
      expect(
        (
          await getDb(ctx.db)
            .select({ status: run.status })
            .from(run)
            .where(eq(run.id, id))
        )[0]?.status,
      ).toBe("running");
      await activateWorkflowDeployment(ctx.db, {
        deploymentId: "synthetic-workflow-rollback",
        workerVersion,
        expectedEpoch: 2,
      });
    };
    await adoptDeployment();
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
    ).toMatchObject({
      result: { id: selected.shortcode, outcome: "frozen" },
    });
    await expect
      .poll(async () => (await instance.status()).status, { timeout: 10_000 })
      .toBe("complete");
  } finally {
    await runtime.close();
  }
}, 120_000);
