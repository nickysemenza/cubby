import { executionAuthorizationInput } from "@cubby/schemas/execution-authorization";
import { fromPartial } from "@total-typescript/shoehorn";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it, vi } from "vitest";

import { setCfEnv } from "~/server/cf-env";
import { account } from "~/server/db/auth.schema";
import { run } from "~/server/db/schema";
import { startMailDiscovery } from "~/server/purchase-import/gmail/discovery";
import { productionMailTriage } from "~/server/purchase-import/gmail/triage-model";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { controlWorkflowRun } from "~/server/workflow-runs/control";
import type { WorkflowLauncher } from "~/server/workflow-runs/launcher";

import { ensureRun } from "./ensure-run";
import { issueExecutionAuthorization } from "./execution-authorization";

// The configured allowance must prevent physical inference, not merely record
// excessive cost afterward. A missing approval must be equally restrictive.
describe("mail routing at the paid transport boundary", () => {
  const ctx = withTestDb();
  afterEach(() => {
    setCfEnv(undefined);
    vi.unstubAllGlobals();
  });

  async function routing(
    condition: "exhausted" | "unapproved" | "cancelled" | "active",
    beforePricing?: () => Promise<void>,
  ) {
    const member = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic routing member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const mailboxId = "synthetic-routing-mailbox";
    await getDb(ctx.db).insert(account).values({
      id: crypto.randomUUID(),
      accountId: mailboxId,
      providerId: "google",
      userId: ctx.actor.userId,
      updatedAt: new Date(),
    });
    const executionAuthorization =
      condition !== "unapproved"
        ? await issueExecutionAuthorization(
            ctx.db,
            ctx.actor,
            executionAuthorizationInput.parse({
              kind: "execution_authorization",
              version: 1,
              owner: { userId: ctx.actor.userId, ledgerPartyId: member.id },
              scope: { kind: "continuous", mailboxId, discovery: "new_mail" },
              meteredBudget: {
                period: "utc_calendar_month",
                limitMicroUSD:
                  condition === "cancelled" || condition === "active"
                    ? 1_000_000
                    : 99,
              },
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            }),
          )
        : undefined;
    const runId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "mail_discovery",
      trigger: "scheduled",
      input: { mailboxId, scopedQueries: [], executionAuthorization },
    });
    if (condition === "cancelled")
      await getDb(ctx.db)
        .update(run)
        .set({
          status: "failed",
          failureCode: "user_cancelled",
          endedAt: new Date(),
        })
        .where(eq(run.id, runId));
    vi.stubGlobal("fetch", async () => {
      await beforePricing?.();
      return Response.json({
        "cloudflare-ai-gateway": {
          id: "cloudflare-ai-gateway",
          models: {
            "typesafe/jev": {
              id: "typesafe/jev",
              cost: { input: 1, output: 0 },
              limit: { context: 100, input: 100, output: 0 },
            },
          },
        },
      });
    });
    const transmit = vi.fn(async () =>
      Response.json({
        answers: {
          selection: {
            type: "choice",
            choice: "c0",
            confidence: 1,
            probabilities: { c0: 1, c1: 0, c2: 0 },
          },
        },
      }),
    );
    setCfEnv(fromPartial<Env>({ AI: { run: transmit } }));
    return {
      runId,
      transmit,
      classify: () =>
        productionMailTriage(
          ctx.db,
          runId,
        )("Synthetic order confirmation for a purchased item"),
    };
  }
  it("refuses transmission when cancellation completes during the pricing fetch", async () => {
    let pricingEntered = () => {};
    let releasePricing = () => {};
    const entered = new Promise<void>((resolve) => {
      pricingEntered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      releasePricing = resolve;
    });
    const { classify, transmit, runId } = await routing("active", async () => {
      pricingEntered();
      await held;
    });
    await Promise.all([
      (async () => {
        await expect(classify()).rejects.toThrow(/executable/iu);
      })(),
      (async () => {
        try {
          await entered;
          const [scope] = await getDb(ctx.db)
            .select({ shortcode: run.shortcode })
            .from(run)
            .where(eq(run.id, runId));
          if (!scope) throw new Error("Synthetic routing Run missing");
          await controlWorkflowRun(
            ctx.db,
            ctx.actor,
            { runPublicId: scope.shortcode, action: "cancel" },
            "mail_discovery",
          );
        } finally {
          releasePricing();
        }
      })(),
    ]);
    expect(transmit).not.toHaveBeenCalled();
  });
  it.each(["unapproved", "cancelled"] as const)(
    "refuses %s routing before transmitting to Workers AI",
    async (condition) => {
      const { classify, transmit } = await routing(condition);
      await expect(classify()).rejects.toThrow(
        /authorization|allowance|budget|executable/iu,
      );
      expect(transmit).not.toHaveBeenCalled();
    },
  );
  it("pauses exhausted routing before transmission and scheduling until the next month", async () => {
    const { classify, transmit, runId } = await routing("exhausted");
    await expect(classify()).rejects.toThrow(/allowance/iu);
    expect(transmit).not.toHaveBeenCalled();
    const [paused] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.id, runId));
    expect(paused).toMatchObject({
      status: "needs_review",
      failureCode: "execution_limit",
    });
    const launched: string[] = [];
    const launcher: WorkflowLauncher = {
      create: async (_purpose, id) => {
        launched.push(id);
      },
      terminate: async () => undefined,
      status: async () => ({ state: "running", error: null }),
    };
    expect(await startMailDiscovery(ctx.db, { launcher })).toEqual({
      started: 0,
      running: 0,
    });
    expect(launched).toEqual([]);
    // A continuous grant opens its next calendar bucket; it never gets a
    // fresh allowance from a retry in the exhausted bucket.
    const priorMonth = new Date();
    priorMonth.setUTCDate(1);
    priorMonth.setUTCMonth(priorMonth.getUTCMonth() - 1);
    await getDb(ctx.db)
      .update(run)
      .set({ endedAt: priorMonth })
      .where(eq(run.id, runId));
    expect(await startMailDiscovery(ctx.db, { launcher })).toEqual({
      started: 1,
      running: 0,
    });
    expect(launched).toHaveLength(1);
  });
});
