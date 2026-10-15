import {
  executionAuthorizationInput,
  executionAuthorizationRef,
} from "@cubby/schemas/execution-authorization";
import { mailReclassifyRunInput } from "@cubby/schemas/run-fields";
import { gatewayFetchThrough } from "@cubby/shared/ai/gateway-request";
import * as decisionModels from "@cubby/shared/ai/models";
import { fromPartial } from "@total-typescript/shoehorn";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { setCfEnv } from "~/server/cf-env";
import { account } from "~/server/db/auth.schema";
import { getDb } from "~/server/db/helpers";
import { run } from "~/server/db/schema";
import { startMailDiscovery } from "~/server/domains/purchase-import/gmail/discovery";
import { productionMailTriage } from "~/server/domains/purchase-import/gmail/triage-model";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { controlWorkflowRun } from "~/server/workflows/runs/control";
import type { WorkflowLauncher } from "~/server/workflows/runs/launcher";

import { ensureRun } from "./ensure-run";
import {
  issueExecutionAuthorization,
  revokeExecutionAuthorization,
} from "./execution-authorization";
import { withRunExecutionAuthorization } from "./execution-context";
import { paidResearchPreflight } from "./execution-transport";

// A catalog cached by another integration file must not bypass this file's
// held pricing socket and the cancellation boundary it exposes.
vi.hoisted(() => {
  vi.resetModules();
});

// The configured allowance must prevent physical inference, not merely record
// excessive cost afterward. A missing approval must be equally restrictive.
describe("mail routing at the paid transport boundary", () => {
  const ctx = withTestDb();
  afterEach(() => {
    vi.restoreAllMocks();
    setCfEnv(undefined);
    vi.unstubAllGlobals();
  });

  async function routing(
    condition: "exhausted" | "unapproved" | "cancelled" | "active",
    beforePricing?: () => Promise<void>,
    executionPolicy: "classification_only" | "import" = "import",
    purpose: "mail_discovery" | "mail_import" = "mail_discovery",
  ) {
    vi.spyOn(decisionModels, "selectDecisionModel").mockReturnValue(
      "typesafe/jev",
    );
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
      purpose,
      trigger: "scheduled",
      input: {
        mailboxId,
        scopedQueries: [],
        executionAuthorization,
        executionPolicy,
      },
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
        openai: {
          id: "openai",
          models: {
            "gpt-6-luna": {
              id: "gpt-6-luna",
              cost: { input: 1, output: 2, reasoning: 3 },
              limit: { context: 100, input: 100, output: 100 },
            },
            "gpt-6-sol": {
              id: "gpt-6-sol",
              cost: { input: 1, output: 2, reasoning: 3 },
              limit: { context: 100, input: 100, output: 100 },
            },
          },
        },
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
  it.each([
    { policy: "classification_only", purpose: "mail_discovery" },
    { policy: "import", purpose: "mail_discovery" },
    { policy: "import", purpose: "mail_import" },
  ] as const)(
    "classifies with the decision model beyond the dollar allowance in $purpose/$policy while paid research stays bounded",
    async ({ policy, purpose }) => {
      const { classify, transmit, runId } = await routing(
        "exhausted",
        undefined,
        policy,
        purpose,
      );
      await expect(classify()).resolves.toBe("related");
      expect(transmit).toHaveBeenCalledTimes(1);
      const [stored] = await getDb(ctx.db)
        .select({ status: run.status })
        .from(run)
        .where(eq(run.id, runId));
      expect(stored?.status).toBe("running");
      const paid = gatewayFetchThrough({
        provider: "openai",
        beforePaidRequest: paidResearchPreflight(ctx.db, runId),
        gateway: transmit,
      });
      await expect(
        paid("https://ai-gateway.invalid/openai/responses", {
          method: "POST",
          body: JSON.stringify({ model: "gpt-6-sol", input: [] }),
        }),
      ).rejects.toThrow(/allowance/iu);
      expect(transmit).toHaveBeenCalledTimes(1);
    },
  );
  // A worker may stop after the transport pause and before the driver catches its error.
  it("persists a recoverable manual budget pause before driver error handling", async () => {
    const { transmit, runId } = await routing("exhausted");
    await getDb(ctx.db)
      .update(run)
      .set({ purpose: "mail_reclassify" })
      .where(eq(run.id, runId));
    const paid = gatewayFetchThrough({
      provider: "openai",
      beforePaidRequest: paidResearchPreflight(ctx.db, runId),
      gateway: transmit,
    });
    await expect(
      paid("https://ai-gateway.invalid/openai/responses", {
        method: "POST",
        body: JSON.stringify({ model: "gpt-6-sol", input: [] }),
      }),
    ).rejects.toThrow(/allowance/iu);
    expect(transmit).not.toHaveBeenCalled();
    const [stored] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.id, runId));
    expect(stored).toMatchObject({
      status: "paused_auth",
      endedAt: null,
      failureCode: "execution_limit",
    });
  });

  it("pauses bulk Luna mail import when its dollar allowance is exhausted", async () => {
    const { transmit, runId } = await routing(
      "exhausted",
      undefined,
      "import",
      "mail_import",
    );
    const paid = gatewayFetchThrough({
      provider: "openai",
      beforePaidRequest: paidResearchPreflight(ctx.db, runId),
      gateway: transmit,
    });
    await expect(
      paid("https://ai-gateway.invalid/openai/responses", {
        method: "POST",
        body: JSON.stringify({ model: "gpt-6-luna", input: [] }),
      }),
    ).rejects.toThrow(/allowance/iu);
    expect(transmit).not.toHaveBeenCalled();
    const [stored] = await getDb(ctx.db)
      .select({ status: run.status })
      .from(run)
      .where(eq(run.id, runId));
    expect(stored?.status).toBe("needs_review");
    await expect(
      paid("https://ai-gateway.invalid/openai/responses", {
        method: "POST",
        body: JSON.stringify({ model: "gpt-6-sol", input: [] }),
      }),
    ).rejects.toThrow(/executable/iu);
    expect(transmit).not.toHaveBeenCalled();
  });

  it("pauses exhausted routing before transmission and scheduling until the next month", async () => {
    const { transmit, runId } = await routing("exhausted");
    const paid = gatewayFetchThrough({
      provider: "openai",
      beforePaidRequest: paidResearchPreflight(ctx.db, runId),
      gateway: transmit,
    });
    await expect(
      paid("https://ai-gateway.invalid/openai/responses", {
        method: "POST",
        body: JSON.stringify({ model: "gpt-6-sol", input: [] }),
      }),
    ).rejects.toThrow(/allowance/iu);
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
  it.each(["active", "exhausted", "unapproved", "cancelled"] as const)(
    "enforces the durable %s allowance before a paid researcher call",
    async (condition) => {
      const { runId } = await routing(condition);
      const transmit = vi.fn(async () => Response.json({ output: [] }));
      const send = gatewayFetchThrough({
        provider: "openai",
        beforePaidRequest: paidResearchPreflight(ctx.db, runId),
        gateway: transmit,
      });
      const result = await send("https://ai-gateway.invalid/openai/responses", {
        method: "POST",
        body: JSON.stringify({ model: "gpt-6-sol", input: [] }),
      }).then(
        (response) => ({ ok: response.ok }),
        (error: unknown) => ({
          error: z.instanceof(Error).parse(error).message,
        }),
      );
      const refused = {
        error: expect.stringMatching(/authorization|allowance|executable/iu),
      };
      expect(result).toMatchObject(
        condition === "active" ? { ok: true } : refused,
      );
      expect(transmit).toHaveBeenCalledTimes(condition === "active" ? 1 : 0);
    },
  );
  // The actual paid transport must honor a validated item binding rather than a frozen old Run input.
  it("admits replacement authority at the real model boundary and in linked manual continuation", async () => {
    const f = await routing("active");
    const [owner] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.id, f.runId));
    const input = z
      .object({
        mailboxId: z.string(),
        executionAuthorization: executionAuthorizationRef,
      })
      .parse(owner!.input);
    const [approval] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.id, input.executionAuthorization.runId));
    const replacement = await issueExecutionAuthorization(
      ctx.db,
      ctx.actor,
      executionAuthorizationInput.parse(approval!.input),
    );
    const manual = mailReclassifyRunInput.parse({
      kind: "mail_reclassify",
      mode: "relevance",
      mailboxId: input.mailboxId,
      executionAuthorization: input.executionAuthorization,
      emails: [
        { emailId: crypto.randomUUID(), checksum: "synthetic-evidence" },
      ],
    });
    await getDb(ctx.db)
      .update(run)
      .set({ purpose: "mail_reclassify", input: manual })
      .where(eq(run.id, f.runId));
    await revokeExecutionAuthorization(
      ctx.db,
      ctx.actor,
      manual.executionAuthorization!,
    );
    await expect(
      withRunExecutionAuthorization(f.runId, replacement, f.classify),
    ).resolves.toBe("related");
    expect(f.transmit).toHaveBeenCalledTimes(1);
    const child = await ensureRun(ctx.db, ctx.actor, {
      purpose: "mail_reclassify",
      trigger: "manual",
      parentRunId: f.runId,
      input: { ...manual, executionAuthorization: replacement },
    });
    expect(
      (await getDb(ctx.db).select().from(run).where(eq(run.id, child)))[0]
        ?.input,
    ).toMatchObject({ executionAuthorization: replacement });
  });
});
