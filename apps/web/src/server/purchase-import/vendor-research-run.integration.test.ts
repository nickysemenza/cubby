import {
  purchaseAgentEvent,
  type PurchaseAgentEvent,
} from "@cubby/schemas/purchase-import";
import {
  targetedImportStartInput,
  targetedImportStartOutput,
} from "@cubby/schemas/run";
import { fromPartial } from "@total-typescript/shoehorn";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it } from "vitest";

import { setCfEnv } from "~/server/cf-env";
import { run, runTarget } from "~/server/db/schema";
import { runHandlers } from "~/server/operations/run.server";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { requireActor } from "~/server/request-context";
import { createTestRequestContext } from "~/server/testing/request-context";

import { researchServiceFor } from "./research-service";
import { controlRun } from "./run-service";

// Known-Vendor discovery must survive missing website/account/Mac, concurrent
// launch, and a failed task retry without falling back to a search-job loop.
describe("known Vendor research", () => {
  const ctx = withTestDb();
  afterEach(() => setCfEnv(undefined));

  async function fixture() {
    const member = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Example discovery member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const seller = await insertWithShortcode(ctx.db, "vendor", {
      name: "Example unfamiliar service provider",
      website: null,
      browserDomains: [],
      orderEmailSenders: [],
    });
    const events: PurchaseAgentEvent[] = [];
    const environment = fromPartial<Env>({
      R2_KEY_PREFIX: "synthetic/vendor-research",
      PURCHASE_AGENT_QUEUE: {
        send: async (event: unknown) => {
          events.push(purchaseAgentEvent.parse(event));
        },
      },
    });
    setCfEnv(environment);
    const context = {
      ...requireActor(
        createTestRequestContext(ctx.db, {
          auth: { userId: ctx.actor.userId },
        }),
      ),
      signal: new AbortController().signal,
    };
    const input = targetedImportStartInput.parse({
      purpose: "account_sync",
      vendorId: seller.shortcode,
    });
    const launch = async () =>
      targetedImportStartOutput.parse(
        await runHandlers.runs.startTargeted!.run(context, input),
      );
    return { member, seller, environment, events, launch };
  }

  it("admits cloud research for a known Vendor without a website or account and reuses concurrent launch", async () => {
    const { member, seller, environment, events, launch } = await fixture();
    const launches = await Promise.all([launch(), launch()]);
    const admitted = launches.map((value) => value.runs[0]?.run?.id);
    expect(admitted[0]).toBeTruthy();
    expect(admitted[1]).toBe(admitted[0]);
    const rows = await getDb(ctx.db).select().from(run);
    expect(rows).toHaveLength(1);
    const [scope] = rows;
    if (!scope) throw new Error("Synthetic admitted Run missing");
    expect(scope).toMatchObject({
      ledgerPartyId: member.id,
      vendorId: seller.id,
      vendorAccountId: null,
      purpose: "account_sync",
      status: "running",
      input: {
        kind: "research_objectives",
        objectives: [
          { kind: "vendor_purchases", vendorId: seller.id, range: null },
        ],
      },
    });
    const tasks = await getDb(ctx.db)
      .select()
      .from(runTarget)
      .where(eq(runTarget.runId, scope.id));
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ state: "pending", vendorAccountId: null });
    expect(events.length).toBeGreaterThan(0);
    expect(
      new Set(
        events.map((event) =>
          event.type === "start_or_resume" ? event.eventId : undefined,
        ),
      ).size,
    ).toBe(1);
    const services = researchServiceFor(ctx.db, environment, scope.id);
    expect(
      await services.researchNext({}, "synthetic-vendor-next"),
    ).toMatchObject({
      status: "working",
      work: {
        workRef: tasks[0]?.id,
        kind: "vendor_purchases",
        vendor: {
          vendorRef: seller.shortcode,
          name: seller.name,
          website: null,
        },
        range: null,
      },
    });
  });

  it("refuses an old Vendor objective retry while a newer public launch owns its active investigation", async () => {
    const { launch } = await fixture();
    const first = (await launch()).runs[0]?.run;
    if (!first) throw new Error("Synthetic predecessor missing");
    await controlRun(ctx.db, ctx.actor, {
      runPublicId: first.id,
      action: "cancel",
    });
    const current = (await launch()).runs[0]?.run;
    if (!current) throw new Error("Synthetic current investigation missing");
    expect(current.id).not.toBe(first.id);
    await expect(
      controlRun(ctx.db, ctx.actor, {
        runPublicId: first.id,
        action: "retry",
      }),
    ).rejects.toThrow(/newer active Vendor research/);
    const rows = await getDb(ctx.db).select().from(run);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.shortcode === current.id)?.status).toBe(
      "running",
    );
  });
});
