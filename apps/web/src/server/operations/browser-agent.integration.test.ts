import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import type { JSONType } from "zod";

import { runOperation } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { requireActor } from "~/server/request-context";
import { createStartOperationRunner } from "~/server/start-operation.server";
import { createTestRequestContext } from "~/server/testing/request-context";
import type { AppSpan } from "~/server/tracing";

import { runHandlers } from "./run.server";
import { vendorHandlers } from "./vendor.server";

// The generated transport must preserve member-scoped browser eligibility,
// actor-owned debug batches, all-or-nothing rejection, and duplicate replay.
describe("browser agent shared operation contracts", () => {
  const ctx = withTestDb();
  const span: AppSpan = {
    isRecording: false,
    setAttribute: () => undefined,
    setAttributes: () => undefined,
    setError: () => undefined,
    recordException: () => undefined,
  };
  const invoke = async (
    domain: "vendor" | "run",
    member: string,
    input: JSONType,
  ) => {
    const operation = (domain === "vendor" ? vendorHandlers : runHandlers).runs[
      member
    ];
    if (!operation)
      throw new Error(`Missing public ${domain}.${member} operation`);
    const runner = createStartOperationRunner({
      authenticate: async () =>
        requireActor(
          createTestRequestContext(ctx.db, {
            auth: { userId: ctx.actor.userId },
          }),
        ),
      observe: async (_definition, _observation, execute) => execute(span),
      markCalendarDirty: () => undefined,
      recordDatabaseWrite: async () => undefined,
    });
    const result = await runner({
      operation: operation.id,
      type: domain === "vendor" ? "query" : "mutation",
      input,
      inputSchema: operation.input,
      outputSchema: operation.output,
      request: { headers: new Headers(), signal: new AbortController().signal },
      run: (context, parsed) =>
        operation.run(
          { ...context, signal: new AbortController().signal },
          parsed,
        ),
    });
    if (!result.ok) throw new Error(result.error.message);
    return result.data;
  };
  async function parties() {
    const own = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic bridge member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const other = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic other member",
      kind: "member",
    });
    return { own, other };
  }

  it("lists only owned live browser-enabled accounts through the generated operation", async () => {
    const { own, other } = await parties();
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic bridge vendor",
    });
    const expected = [];
    for (const status of ["active", "paused_auth", "paused_offline"] as const) {
      const seller = await insertWithShortcode(ctx.db, "vendor", {
        name: `Synthetic ${status} shop`,
      });
      expected.push(
        await insertWithShortcode(ctx.db, "vendorAccount", {
          vendorId: seller.id,
          ledgerPartyId: own.id,
          label: status,
          browserSyncEnabled: true,
          status,
          browser: "chrome",
        }),
      );
    }
    await insertWithShortcode(ctx.db, "vendorAccount", {
      vendorId: vendor.id,
      ledgerPartyId: other.id,
      label: "Foreign",
      browserSyncEnabled: true,
      status: "active",
    });
    await insertWithShortcode(ctx.db, "vendorAccount", {
      vendorId: (
        await insertWithShortcode(ctx.db, "vendor", {
          name: "Synthetic mail shop",
        })
      ).id,
      ledgerPartyId: own.id,
      label: "Mail only",
      browserSyncEnabled: false,
      status: "active",
    });
    await insertWithShortcode(ctx.db, "vendorAccount", {
      vendorId: (
        await insertWithShortcode(ctx.db, "vendor", {
          name: "Synthetic deleted shop",
        })
      ).id,
      ledgerPartyId: own.id,
      label: "Deleted",
      browserSyncEnabled: true,
      status: "active",
      deletedAt: new Date(),
    });
    expect(await invoke("vendor", "browserAccounts", {})).toEqual({
      accounts: expected.map((account) => ({
        id: account.shortcode,
        label: account.label,
        ledgerPartyId: own.shortcode,
        browser: account.browser,
      })),
    });
  });

  it("rejects an entire mixed-owner debug batch and replays an owned batch without duplicate events", async () => {
    const { own, other } = await parties();
    const scopes = [];
    for (const party of [own, other]) {
      scopes.push(
        await insertWithShortcode(ctx.db, "run", {
          purpose: "mail_import",
          status: "running",
          trigger: "manual",
          ledgerPartyId: party.id,
          actorUserId: ctx.actor.userId,
          actorName: "Synthetic actor",
          actorEmail: "bridge@example.test",
          actorLedgerPartyShortcode: party.shortcode,
          actorLedgerPartyName: party.name,
          actorLedgerPartyKind: "member",
        }),
      );
    }
    const [owned, foreign] = scopes;
    if (!owned || !foreign) throw new Error("Synthetic runs unavailable");
    const event = (runId: string) => ({
      id: crypto.randomUUID(),
      occurredAt: new Date().toISOString(),
      event: "command.started",
      runId,
      operationKind: "navigate",
      browser: "chrome",
    });
    const good = event(owned.id);
    await expect(
      invoke("run", "browserDebugEvents", {
        events: [good, event(foreign.id)],
      }),
    ).rejects.toThrow(/not found|own/i);
    expect(
      await getDb(ctx.db)
        .select()
        .from(runOperation)
        .where(eq(runOperation.runId, owned.id)),
    ).toHaveLength(0);
    expect(
      await invoke("run", "browserDebugEvents", { events: [good] }),
    ).toEqual({ accepted: 1 });
    expect(
      await invoke("run", "browserDebugEvents", { events: [good] }),
    ).toEqual({ accepted: 0 });
    expect(
      await getDb(ctx.db)
        .select()
        .from(runOperation)
        .where(eq(runOperation.runId, owned.id)),
    ).toHaveLength(1);
  });
});
