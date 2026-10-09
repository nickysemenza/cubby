import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { bridgeServerMessage, type BrowserBridgeResult } from "./contracts";
import { PurchaseImportSqlStore } from "./sql-store";

const command = {
  protocolVersion: 4 as const,
  id: "894efe4d-8567-56db-9c06-e533b9945c6f",
  operationId: "browser-command:nav-001",
  runID: "df62c017-5669-4d6d-9f7e-088b6bcffc9f",
  deadline: "2026-09-20T00:00:00.000Z",
  operation: {
    type: "navigate" as const,
    url: "https://example.com/orders",
    allowedHosts: ["example.com"],
  },
};

const result: BrowserBridgeResult = {
  protocolVersion: 4,
  // Foundation's UUID Codable representation is uppercase while the web
  // command producer emits lowercase UUID strings.
  commandID: command.id.toUpperCase(),
  operationID: command.operationId,
  runID: command.runID,
  completedAt: "2026-09-19T21:50:00.000Z",
  outcome: {
    status: "completed",
    snapshot: null,
    observation: {
      url: null,
      title: null,
      readyState: null,
      window: null,
      screenRecording: "unknown",
      durationMs: 0,
    },
  },
};

describe("purchase-import broker SQLite", () => {
  // Offline recipients retain bytes after server cache deletion. Another Mac,
  // late result, wake, completion, or an acknowledgement for another receipt
  // must not certify erasure. Authorized source receipts share one Run disposal.
  it("keeps forget pending until every actual recipient acknowledges and fences retired replay", async () => {
    const stub = env.DB_FRESHNESS.getByName(crypto.randomUUID());
    await runInDurableObject(stub, (_instance, state) => {
      const store = new PurchaseImportSqlStore(state.storage);
      store.migrate();
      const device = "11111111-1111-4111-8111-111111111111";
      const otherDevice = "22222222-2222-4222-8222-222222222222";
      const receipt = "33333333-3333-4333-8333-333333333333";
      const overlappingReceipt = "44444444-4444-4444-8444-444444444444";
      const other = {
        ...command,
        id: crypto.randomUUID(),
        runID: crypto.randomUUID(),
      };
      store.enqueue(command);
      store.enqueue(other);
      store.recordDelivery(command.id, device);
      store.claimResult(result);
      store.rememberWake(command.runID);
      expect(store.forgetRun(command.runID, receipt)).toEqual({
        forgotten: false,
      });
      expect(store.result(command.id)).toBeNull();
      expect(store.nextWake()).toBeNull();
      expect(store.nextReplayable()).toEqual(other);
      expect(() => store.enqueue(command)).toThrow(/retired/i);
      expect(store.claimResult(result)).toEqual({
        command: null,
        newlyCompleted: false,
      });
      store.rememberWake(command.runID);
      expect(store.nextWake()).toBeNull();
      store.acknowledgeForget(command.runID, receipt, otherDevice);
      expect(store.forgetRun(command.runID, receipt)).toEqual({
        forgotten: false,
      });
      expect(store.pendingForgets(device)).toEqual([
        { runId: command.runID, receiptId: receipt },
      ]);
      const coldStore = new PurchaseImportSqlStore(state.storage);
      expect(coldStore.forgetRun(command.runID, overlappingReceipt)).toEqual({
        forgotten: false,
      });
      coldStore.acknowledgeForget(command.runID, overlappingReceipt, device);
      expect(coldStore.pendingForgets(device)).toEqual([
        { runId: command.runID, receiptId: receipt },
      ]);
      store.acknowledgeForget(command.runID, receipt, device);
      expect(store.forgetRun(command.runID, receipt)).toEqual({
        forgotten: true,
      });
      expect(store.pendingForgets(device)).toEqual([]);
      expect(coldStore.forgetRun(command.runID, overlappingReceipt)).toEqual({
        forgotten: true,
      });
      const retained = state.storage.sql
        .exec<{ request_json: string }>(
          "SELECT request_json FROM broker_command WHERE run_id = ?",
          command.runID,
        )
        .toArray();
      expect(retained).toEqual([]);
    });
  });

  it("does not claim erasure for historical deliveries without device identity", async () => {
    const stub = env.DB_FRESHNESS.getByName(crypto.randomUUID());
    await runInDurableObject(stub, (_instance, state) => {
      const store = new PurchaseImportSqlStore(state.storage);
      store.migrate();
      store.enqueue(command);
      store.markSent(command.id);
      const receipt = crypto.randomUUID();
      expect(store.forgetRun(command.runID, receipt)).toEqual({
        forgotten: false,
      });
      expect(store.forgetRun(command.runID, crypto.randomUUID())).toEqual({
        forgotten: false,
      });
      store.acknowledgeForget(command.runID, receipt, crypto.randomUUID());
      expect(store.forgetRun(command.runID, receipt)).toEqual({
        forgotten: false,
      });
    });
  });

  it("removes a claimed result from the replay queue before acknowledging it", async () => {
    const stub = env.DB_FRESHNESS.getByName(crypto.randomUUID());

    await runInDurableObject(stub, (_instance, state) => {
      const store = new PurchaseImportSqlStore(state.storage);
      store.migrate();
      store.enqueue(command);
      store.markSent(command.id);

      expect(store.nextReplayable()).toEqual(command);
      expect(store.claimResult(result)).toEqual({
        command,
        newlyCompleted: true,
      });
      expect(store.nextReplayable()).toBeNull();
      expect(store.claimResult(result)).toEqual({
        command,
        newlyCompleted: false,
      });
      expect(store.nextReplayable()).toBeNull();
    });
  });

  // A run paused on a failed step (a minimized window, a missing permission)
  // once stayed paused after the Mac reconnected: nothing was left to replay,
  // so nothing woke it. The broker now remembers it until a step succeeds.
  it("remembers a run whose step failed until a later step succeeds", async () => {
    const stub = env.DB_FRESHNESS.getByName(crypto.randomUUID());
    await runInDurableObject(stub, (_instance, state) => {
      const store = new PurchaseImportSqlStore(state.storage);
      store.migrate();
      store.rememberWake("run-a");
      store.rememberWake("run-b");
      store.forgetWake("run-b");
      const wake = store.nextWake();
      expect(wake?.runId).toBe("run-a");
      // An unpublished wake survives for the next reconnect.
      expect(store.nextWake()).toEqual(wake);
      store.forgetWake("run-a", wake!.generation);
      expect(store.nextWake()).toBeNull();
    });
  });

  // A run paused on a step an older protocol finished has nothing to replay;
  // the first start after the cut wakes it so the server stops it for review.
  it("wakes the run of a finished older-protocol step on first migration", async () => {
    const stub = env.DB_FRESHNESS.getByName(crypto.randomUUID());
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "CREATE TABLE broker_command (request_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, run_id TEXT NOT NULL, request_json TEXT NOT NULL, state TEXT NOT NULL, result_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
      );
      state.storage.sql.exec(
        "INSERT INTO broker_command (request_id, operation_id, run_id, request_json, state, created_at, updated_at) VALUES (?, ?, ?, ?, 'completed', ?, ?)",
        command.id,
        command.operationId,
        command.runID,
        JSON.stringify({ ...command, protocolVersion: 2 }),
        Date.now(),
        Date.now(),
      );
      const store = new PurchaseImportSqlStore(state.storage);
      store.migrate();
      expect(store.nextWake()?.runId).toBe(command.runID);
      store.forgetWake(command.runID);
      store.migrate();
      expect(store.nextWake()).toBeNull();
    });
  });

  // The cut to protocol 3 cancels commands no current Mac can run; their run
  // must still be woken so the server stops it for review.
  it("wakes the run of a command from an older protocol it cancels", async () => {
    const stub = env.DB_FRESHNESS.getByName(crypto.randomUUID());
    await runInDurableObject(stub, (_instance, state) => {
      const store = new PurchaseImportSqlStore(state.storage);
      store.migrate();
      state.storage.sql.exec(
        "INSERT INTO broker_command (request_id, operation_id, run_id, request_json, state, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', 1, 1)",
        command.id,
        command.operationId,
        command.runID,
        JSON.stringify({ ...command, protocolVersion: 2 }),
      );
      expect(store.nextReplayable()).toBeNull();
      expect(store.nextWake()?.runId).toBe(command.runID);
    });
  });

  it("acknowledges a browser result without replaying its completed command", async () => {
    const stub = env.PURCHASE_IMPORT.getByName(crypto.randomUUID());
    await stub.enqueue(command);

    const response = await stub.fetch(
      new Request("https://broker.test/socket", {
        headers: {
          Upgrade: "websocket",
          "x-cubby-ledger-party-id": "LPY-TEST",
          "x-cubby-vendor-account-id": "VACCT-TEST",
          "x-cubby-user-id": "USR-TEST",
        },
      }),
    );
    const socket = response.webSocket;
    expect(socket).toBeDefined();
    if (!socket) throw new Error("Durable Object did not return a WebSocket");
    socket.accept();

    socket.send(
      JSON.stringify({
        protocolVersion: 4,
        type: "hello",
        deviceID: "11111111-1111-4111-8111-111111111111",
        browser: "chrome",
        capabilities: {
          snapshotVersion: 2,
          screenshot: true,
          actions: [
            "navigate",
            "read",
            "click",
            "type",
            "select",
            "scroll",
            "window",
          ],
        },
      }),
    );
    expect(await receiveMessage(socket)).toMatchObject({
      type: "command",
      command: { id: command.id },
    });

    socket.send(JSON.stringify({ protocolVersion: 4, type: "result", result }));
    expect(await receiveMessage(socket)).toEqual({
      protocolVersion: 4,
      type: "acknowledge",
      commandID: command.id,
    });
    // Even a future state-regression bug must not defeat the durable
    // completion tombstone and repeat a browser side effect.
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE broker_command SET state = 'sent' WHERE request_id = ?",
        command.id,
      );
    });
    const noReplay = expectNoMessage(socket);
    await stub.enqueue(command);
    await noReplay;
    socket.close(1000, "test complete");
  });
});

function receiveMessage(
  socket: WebSocket,
): Promise<z.output<typeof bridgeServerMessage>> {
  return new Promise((resolve, reject) => {
    socket.addEventListener(
      "message",
      (event) => {
        try {
          resolve(bridgeServerMessage.parse(JSON.parse(String(event.data))));
        } catch (error) {
          reject(error);
        }
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => reject(new Error("WebSocket failed")),
      {
        once: true,
      },
    );
  });
}

async function expectNoMessage(socket: WebSocket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, 100);
    socket.addEventListener(
      "message",
      () => {
        clearTimeout(timeout);
        reject(new Error("Completed command was replayed"));
      },
      { once: true },
    );
  });
}
