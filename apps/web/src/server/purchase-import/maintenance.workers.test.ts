import type { WebSocket as CfWebSocket } from "@cloudflare/workers-types";
import { fromPartial } from "@total-typescript/shoehorn";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";

import { PurchaseImportRunAgentHost } from "./agent-host";
import { runServicesFor } from "./agent-services";
import { PurchaseImportObject } from "./durable-object";
import { PurchaseImportSqlStore } from "./sql-store";

declare const WebSocketPair: {
  new (): { 0: CfWebSocket; 1: CfWebSocket };
};

vi.hoisted(() => {
  Object.assign(process.env, {
    NODE_ENV: "test",
    R2_ACCESS_KEY_ID: "synthetic-access",
    R2_SECRET_ACCESS_KEY: "synthetic-secret",
    R2_ENDPOINT: "https://objects.example.test",
    R2_BUCKET_NAME: "synthetic-bucket",
    R2_PUBLIC_URL: "https://images.example.test",
    BETTER_AUTH_SECRET: "synthetic-maintenance-auth",
  });
});

// Maintenance must precede Postgres access, agent hydration and browser ACKs.
// Pausing queues alone cannot stop an alarm or an already-connected Mac.
const maintenanceEnv = {
  ...env,
  MAINTENANCE_MODE: "true",
  HYPERDRIVE: fromPartial<Env["HYPERDRIVE"]>({
    connectionString: "postgresql://synthetic:synthetic@localhost/synthetic",
  }),
};
const runId = "df62c017-5669-4d6d-9f7e-088b6bcffc9f";

describe("purchase research migration quiescence", () => {
  it("rejects coordinator HTTP before accessing the migration-sensitive database", async () => {
    vi.stubGlobal("__GIT_COMMIT__", "synthetic-maintenance-test");
    const stub = env.DB_FRESHNESS.getByName(`import-run:${runId}`);
    await runInDurableObject(stub, async (_instance, state) => {
      const host = new PurchaseImportRunAgentHost(state, maintenanceEnv);
      const response = await host.fetch(
        new Request("https://example.test/api/research"),
      );
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("300");
    });
  });

  it("defers an alarm while preserving durable conversation state", async () => {
    vi.stubGlobal("__GIT_COMMIT__", "synthetic-maintenance-test");
    const stub = env.DB_FRESHNESS.getByName(
      `import-run:${crypto.randomUUID()}`,
    );
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("synthetic-conversation", { turn: 4 });
      const before = Date.now();
      const host = new PurchaseImportRunAgentHost(state, maintenanceEnv);
      await host.alarm();
      expect(await state.storage.get("synthetic-conversation")).toEqual({
        turn: 4,
      });
      expect(await state.storage.getAlarm()).toBeGreaterThanOrEqual(
        before + 300_000,
      );
      await state.storage.deleteAlarm();
    });
  });

  it("rejects coordinator delivery for retry without hydrating the agent", async () => {
    vi.stubGlobal("__GIT_COMMIT__", "synthetic-maintenance-test");
    const stub = env.DB_FRESHNESS.getByName(
      `import-run:${crypto.randomUUID()}`,
    );
    await runInDurableObject(stub, async (_instance, state) => {
      const host = new PurchaseImportRunAgentHost(state, maintenanceEnv);
      await expect(
        host.dispatch({
          identity: { runId, purpose: "product_enrichment" },
          operationId: "synthetic-delivery",
          signal: { type: "start", body: "" },
        }),
      ).rejects.toThrow(/maintenance/i);
    });
  });

  it("fences a tool from an already-loaded coordinator before its database effect", async () => {
    const stub = env.DB_FRESHNESS.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (_instance, state) => {
      const services = runServicesFor(maintenanceEnv, state, runId);
      await expect(async () =>
        services.researchNext({}, "synthetic-tool"),
      ).rejects.toThrow(/maintenance/i);
    });
  });

  it("refuses new browser connections and commands without changing retained work", async () => {
    const stub = env.DB_FRESHNESS.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (_instance, state) => {
      const broker = new PurchaseImportObject(state, maintenanceEnv);
      const response = await broker.fetch(
        new Request("https://example.test/browser"),
      );
      expect(response.status).toBe(503);
      const command = {
        protocolVersion: 4 as const,
        id: crypto.randomUUID(),
        operationId: "synthetic-browser-command",
        runID: runId,
        deadline: new Date(Date.now() + 60_000).toISOString(),
        operation: {
          type: "navigate" as const,
          url: "https://example.test/product",
          allowedHosts: ["example.test"],
        },
      };
      await expect(broker.enqueue(command)).rejects.toThrow(/maintenance/i);
      expect(await broker.pendingCommands(runId)).toEqual([]);
    });
  });

  it("closes an existing browser without accepting or acknowledging its retained result", async () => {
    const stub = env.DB_FRESHNESS.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (_instance, state) => {
      const broker = new PurchaseImportObject(state, maintenanceEnv);
      const store = new PurchaseImportSqlStore(state.storage);
      const command = {
        protocolVersion: 4 as const,
        id: crypto.randomUUID(),
        operationId: "synthetic-retained-result",
        runID: runId,
        deadline: new Date(Date.now() + 60_000).toISOString(),
        operation: {
          type: "navigate" as const,
          url: "https://example.test/product",
          allowedHosts: ["example.test"],
        },
      };
      store.enqueue(command);
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      state.acceptWebSocket(server);
      client.accept();
      server.serializeAttachment({
        protocolVersion: 4,
        ledgerPartyId: crypto.randomUUID(),
        vendorAccountId: crypto.randomUUID(),
        userId: crypto.randomUUID(),
        deviceID: crypto.randomUUID(),
      });
      const messages: string[] = [];
      client.addEventListener("message", (event) => {
        messages.push(String(event.data));
      });
      await broker.webSocketMessage(
        server,
        JSON.stringify({
          protocolVersion: 4,
          type: "result",
          result: {
            protocolVersion: 4,
            commandID: command.id,
            operationID: command.operationId,
            runID: runId,
            completedAt: new Date().toISOString(),
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
          },
        }),
      );
      expect(store.result(command.id)).toBeNull();
      expect(store.nextReplayable()).toEqual(command);
      expect(messages).toEqual([]);
      expect(server.readyState).not.toBe(WebSocket.OPEN);
      client.close();
    });
  });
});
