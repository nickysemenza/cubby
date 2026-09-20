import type { BrowserBridgeRequest } from "@cubby/schemas/purchase-import";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  finishImportRun,
  issueBrowserCommand,
  runImportOperation,
  startOrResumeImportRun,
} from "./run-service";

describe("purchase import run admission", () => {
  const ctx = withTestDb();

  const createMember = async () => {
    const { insertWithShortcode } =
      await import("~/server/repo/shortcode-utils");
    return insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Import test member",
      kind: "member",
      userId: ctx.actor.userId,
    });
  };

  const createVendorAccount = async (
    ledgerPartyId: Awaited<ReturnType<typeof createMember>>["id"],
  ) => {
    const { insertWithShortcode } =
      await import("~/server/repo/shortcode-utils");
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: `Import vendor ${crypto.randomUUID()}`,
      website: "https://shop.example.test/orders",
      browserDomains: ["shop.example.test"],
    });
    return insertWithShortcode(ctx.db, "vendorAccount", {
      label: "Import test account",
      vendorId: vendor.id,
      ledgerPartyId,
    });
  };

  it("atomically admits one active run per vendor account", async () => {
    const party = await createMember();
    const account = await createVendorAccount(party.id);

    const [first, second] = await Promise.all([
      startOrResumeImportRun(ctx.db, {
        ledgerPartyId: party.id,
        vendorAccountId: account.id,
        trigger: "manual",
      }),
      startOrResumeImportRun(ctx.db, {
        ledgerPartyId: party.id,
        vendorAccountId: account.id,
        trigger: "foreground",
      }),
    ]);

    expect(first.id).toBe(second.id);
    expect([first.created, second.created].sort()).toEqual([false, true]);
  });

  it("returns the recorded tool result without replaying its effect", async () => {
    const party = await createMember();
    const account = await createVendorAccount(party.id);
    const run = await startOrResumeImportRun(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: account.id,
      trigger: "manual",
    });
    let calls = 0;
    const input = {
      runId: run.id,
      operationId: "test:replay",
      kind: "test",
      payload: { value: 7 },
    };
    const first = await runImportOperation(ctx.db, input, async () => {
      calls += 1;
      return { value: 7 };
    });
    const replay = await runImportOperation(ctx.db, input, async () => {
      calls += 1;
      return { value: 9 };
    });

    expect(first).toEqual({ value: 7 });
    expect(replay).toEqual(first);
    expect(calls).toBe(1);
    await expect(
      runImportOperation(
        ctx.db,
        { ...input, payload: { value: 8 } },
        async () => ({ value: 8 }),
      ),
    ).rejects.toThrow("different input");
  });

  it("reclaims a stale started operation after a worker crash", async () => {
    const party = await createMember();
    const account = await createVendorAccount(party.id);
    const run = await startOrResumeImportRun(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: account.id,
      trigger: "manual",
    });
    const input = {
      runId: run.id,
      operationId: "test:stale-operation",
      kind: "test",
      payload: { value: 1 },
    };
    await expect(
      runImportOperation(ctx.db, input, async () => {
        throw new Error("injected crash");
      }),
    ).rejects.toThrow("injected crash");
    const [{ eq }, { getDb }, { importRunOperation }] = await Promise.all([
      import("drizzle-orm"),
      import("~/server/repo/database-helpers"),
      import("~/server/db/schema"),
    ]);
    await getDb(ctx.db)
      .update(importRunOperation)
      .set({ state: "started", updatedAt: new Date(Date.now() - 6 * 60_000) })
      .where(eq(importRunOperation.operationId, input.operationId));

    await expect(
      runImportOperation(ctx.db, input, async () => ({ recovered: true })),
    ).resolves.toEqual({ recovered: true });
  });

  it("replays the exact persisted browser command for one operation id", async () => {
    const party = await createMember();
    const account = await createVendorAccount(party.id);
    const run = await startOrResumeImportRun(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: account.id,
      trigger: "manual",
    });
    const commands: BrowserBridgeRequest[] = [];
    const broker = {
      enqueue: async (command: BrowserBridgeRequest) => {
        commands.push(command);
      },
      result: async () => null,
      cancel: async () => undefined,
      connected: async () => true,
      notifyRunCompleted: async () => undefined,
      requestAuthentication: async () => undefined,
    };
    const namespace = { getByName: () => broker };
    const input = {
      runId: run.id,
      operationId: "browser:stable-command",
      operation: {
        type: "navigate" as const,
        url: "https://shop.example.test/orders",
        allowedHosts: ["shop.example.test"],
      },
    };

    const first = await issueBrowserCommand(ctx.db, namespace, input);
    const replay = await issueBrowserCommand(ctx.db, namespace, input);

    expect(replay).toEqual(first);
    expect(commands).toHaveLength(2);
    expect(commands[1]).toEqual(commands[0]);
  });

  it("rejects a capture recovery URL outside the vendor allowlist", async () => {
    const party = await createMember();
    const account = await createVendorAccount(party.id);
    const run = await startOrResumeImportRun(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: account.id,
      trigger: "manual",
    });
    const broker = {
      enqueue: async () => undefined,
      result: async () => null,
      cancel: async () => undefined,
      connected: async () => true,
      notifyRunCompleted: async () => undefined,
      requestAuthentication: async () => undefined,
    };

    await expect(
      issueBrowserCommand(
        ctx.db,
        { getByName: () => broker },
        {
          runId: run.id,
          operationId: "browser:disallowed-recovery",
          operation: {
            type: "capture",
            allowedHosts: ["shop.example.test"],
            enhancedEvidence: false,
            recoveryURL: "https://attacker.example/orders",
          },
        },
      ),
    ).rejects.toThrow("outside the vendor allowlist");
  });

  it("replays terminal completion after the run status already committed", async () => {
    const party = await createMember();
    const account = await createVendorAccount(party.id);
    const run = await startOrResumeImportRun(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: account.id,
      trigger: "manual",
    });
    const notifications: string[] = [];
    const broker = {
      enqueue: async () => undefined,
      result: async () => null,
      cancel: async () => undefined,
      connected: async () => true,
      notifyRunCompleted: async ({ runID }: { runID: string }) => {
        notifications.push(runID);
      },
      requestAuthentication: async () => undefined,
    };
    const namespace = { getByName: () => broker };
    const input = { runId: run.id, operationId: "finish:replay" };

    const first = await finishImportRun(ctx.db, namespace, input);
    const replay = await finishImportRun(ctx.db, namespace, input);

    expect(replay).toEqual(first);
    expect(notifications).toEqual([run.id, run.id]);
  });
});
