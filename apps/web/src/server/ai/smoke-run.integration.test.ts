import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  aiAnalysis,
  importFinding,
  importRun,
  orderMail,
} from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { requireActor } from "~/server/request-context";
import { createTestRequestContext } from "~/server/testing/request-context";

import { PURCHASE_IMPORT_MAIL_FEATURE } from "./features";
import type { StructuredRunPorts } from "./run-feature";
import { runAiSmoke } from "./smoke-run";

describe("AI smoke dispatch", () => {
  const ctx = withTestDb();

  it("routes order mail through its production request without workflow writes", async () => {
    const calls: unknown[] = [];
    const capture = async (
      args: Parameters<StructuredRunPorts["chat"]>[0],
    ): Promise<string> => {
      calls.push(args);
      const response = {
        event: "other",
        orderId: null,
        amount: null,
        currency: null,
        occurredAt: null,
      };
      // SAFETY: the runner validates the returned fixture against the mail schema.
      // This port has the full generic chat signature only for the smoke test.
      return response as string;
    };
    // SAFETY: capture observes the options and returns the fixture for the
    // non-streaming structured branch exercised by this test.
    const ports: StructuredRunPorts = {
      chat: capture as StructuredRunPorts["chat"],
    };
    const actor = requireActor(
      createTestRequestContext(ctx.db, {
        auth: { userId: ctx.actor.userId },
      }),
    );
    const attempt = await runAiSmoke(
      actor,
      "purchaseMail",
      {
        fixture: "standard",
      },
      ports,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      outputSchema: PURCHASE_IMPORT_MAIL_FEATURE.schema,
      messages: expect.any(Array),
    });
    expect(attempt).toMatchObject({
      status: "no_model_call",
      feature: PURCHASE_IMPORT_MAIL_FEATURE.feature,
      runShortcode: expect.any(String),
    });
    const runs = await getDb(ctx.db)
      .select({ shortcode: importRun.shortcode })
      .from(importRun);
    expect(runs).toEqual([{ shortcode: attempt.runShortcode }]);
    for (const table of [orderMail, importFinding, aiAnalysis]) {
      expect(await getDb(ctx.db).select({ id: table.id }).from(table)).toEqual(
        [],
      );
    }
  });
});
