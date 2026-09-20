import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { bridgeServerMessage, type BrowserBridgeResult } from "./contracts";
import { PurchaseImportSqlStore } from "./sql-store";

const command = {
  protocolVersion: 2 as const,
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
  protocolVersion: 2,
  // Foundation's UUID Codable representation is uppercase while the web
  // command producer emits lowercase UUID strings.
  commandID: command.id.toUpperCase(),
  operationID: command.operationId,
  runID: command.runID,
  completedAt: "2026-09-19T21:50:00.000Z",
  outcome: { status: "completed" },
};

describe("purchase-import broker SQLite", () => {
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
        protocolVersion: 2,
        type: "hello",
        deviceID: "11111111-1111-4111-8111-111111111111",
        browser: "chrome",
        capabilities: {
          fixedCaptureVersion: 1,
          enhancedScreenshot: false,
          renderedPDF: true,
        },
      }),
    );
    expect(await receiveMessage(socket)).toMatchObject({
      type: "command",
      command: { id: command.id },
    });

    socket.send(JSON.stringify({ protocolVersion: 2, type: "result", result }));
    expect(await receiveMessage(socket)).toEqual({
      protocolVersion: 2,
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
