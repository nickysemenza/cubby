/* eslint-disable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion -- This workerd-only transport shim receives Cloudflare Queue and WebSocket wire payloads. */
import type {
  DurableObjectNamespace,
  MessageEvent as CfMessageEvent,
  WebSocket as CfWebSocket,
} from "@cloudflare/workers-types";
import { z } from "zod";
import { agentImportRunPurpose } from "@cubby/schemas/import-run-agent";
import {
  BROWSER_BRIDGE_PROTOCOL,
  browserBridgeRequest,
  purchaseAgentEvent,
} from "@cubby/schemas/purchase-import";
import { dispatchInputForEvent } from "../../../src/server/purchase-agent/queue-dispatch";
import type {
  PurchaseImportDurableObject,
  PurchaseImportRunAgent,
} from "../../../src/server/worker-bindings";

const activeBrowserSockets = new Set<CfWebSocket>();

export default {
  async fetch(
    request: Request,
    env: {
      PURCHASE_AGENT_QUEUE: { send(message: unknown): Promise<void> };
      PURCHASE_IMPORT_CLIENT: DurableObjectNamespace<PurchaseImportDurableObject>;
      PURCHASE_AGENT_RUN_CLIENT: DurableObjectNamespace<PurchaseImportRunAgent>;
    },
  ) {
    const url = new URL(request.url);
    if (request.method !== "POST")
      return new Response("Not found", { status: 404 });
    if (url.pathname === "/dispatch") {
      await env.PURCHASE_AGENT_QUEUE.send(await request.json());
      return new Response(null, { status: 202 });
    }
    if (url.pathname === "/coordinator-fetch") {
      const input = z
        .object({ agentId: z.string() })
        .parse(await request.json());
      const response = await env.PURCHASE_AGENT_RUN_CLIENT.getByName(
        input.agentId,
      ).fetch("https://coordinator.test/");
      return new Response(await response.text(), { status: response.status });
    }
    if (url.pathname === "/coordinator-retire") {
      const input = z
        .object({ agentId: z.string(), receiptId: z.uuid() })
        .parse(await request.json());
      return Response.json(
        await env.PURCHASE_AGENT_RUN_CLIENT.getByName(input.agentId).retire({
          receiptId: input.receiptId,
        }),
      );
    }
    if (url.pathname === "/coordinator-dispatch") {
      const input = z
        .object({
          agentId: z.string(),
          purpose: agentImportRunPurpose,
          event: purchaseAgentEvent,
        })
        .parse(await request.json());
      return Response.json(
        await env.PURCHASE_AGENT_RUN_CLIENT.getByName(input.agentId).dispatch(
          dispatchInputForEvent(input.event, input.purpose),
        ),
      );
    }
    if (url.pathname === "/broker-enqueue") {
      const input = z
        .object({ vendorAccountId: z.uuid(), command: browserBridgeRequest })
        .parse(await request.json());
      await env.PURCHASE_IMPORT_CLIENT.getByName(input.vendorAccountId).enqueue(
        input.command,
      );
      return new Response(null, { status: 202 });
    }
    if (url.pathname === "/broker-state") {
      const input = z
        .object({
          vendorAccountId: z.uuid(),
          runId: z.uuid(),
          commandId: z.uuid(),
        })
        .parse(await request.json());
      const broker = env.PURCHASE_IMPORT_CLIENT.getByName(
        input.vendorAccountId,
      );
      return Response.json({
        result: await broker.result(input.commandId),
        pending: await broker.pendingCommands(input.runId),
        connected: await broker.connected(),
      });
    }
    if (url.pathname === "/broker-forget") {
      const input = z
        .object({
          vendorAccountId: z.uuid(),
          runId: z.uuid(),
          receiptId: z.uuid(),
        })
        .parse(await request.json());
      return Response.json(
        await env.PURCHASE_IMPORT_CLIENT.getByName(
          input.vendorAccountId,
        ).forgetRun(input),
      );
    }
    if (url.pathname !== "/browser-connect")
      return new Response("Not found", { status: 404 });

    // One simulated Mac browser for a vendor account. It stays connected and
    // answers commands by source URL or the observed control reference, so
    // a run can navigate and interact over the same real broker connection.
    const input = (await request.json()) as {
      vendorAccountId: string;
      ledgerPartyId: string;
      userId: string;
      outcomes?: Record<string, unknown>;
      actionOutcomes?: Record<string, unknown>;
      /** Capture latency before each result, as a real browser takes. */
      delayMs?: number;
      deviceID?: string;
      autoForgetAck?: boolean;
      initialForgetAck?: {
        runID: string;
        retirementID: string;
        deviceID: string;
      };
    };
    const response = await env.PURCHASE_IMPORT_CLIENT.getByName(
      input.vendorAccountId,
    ).fetch(new URL("https://broker.test/socket"), {
      headers: {
        Upgrade: "websocket",
        "x-cubby-ledger-party-id": input.ledgerPartyId,
        "x-cubby-vendor-account-id": input.vendorAccountId,
        "x-cubby-user-id": input.userId,
      },
    });
    const socket = response.webSocket;
    if (!socket) return new Response("Broker upgrade failed", { status: 502 });
    socket.accept();
    activeBrowserSockets.add(socket);
    socket.addEventListener("close", () => activeBrowserSockets.delete(socket));

    socket.addEventListener("message", (event: CfMessageEvent) => {
      const message = JSON.parse(String(event.data)) as {
        type?: string;
        runID?: string;
        retirementID?: string;
        command?: {
          id: string;
          operationId: string;
          runID: string;
          operation: { url?: string; recoveryURL?: string; ref?: string };
        };
      };
      if (message.type === "forget_run" && input.autoForgetAck) {
        socket.send(
          JSON.stringify({
            protocolVersion: BROWSER_BRIDGE_PROTOCOL,
            type: "forget_run_ack",
            runID: message.runID,
            retirementID: message.retirementID,
            deviceID: input.deviceID ?? "11111111-1111-4111-8111-111111111111",
          }),
        );
        return;
      }
      if (message.type !== "command" || !message.command) return;
      const command = message.command;
      const target = command.operation.url ?? command.operation.recoveryURL;
      const actionOutcome = command.operation.ref
        ? input.actionOutcomes?.[command.operation.ref]
        : undefined;
      const reply = () =>
        socket.send(
          JSON.stringify({
            protocolVersion: BROWSER_BRIDGE_PROTOCOL,
            type: "result",
            result: {
              protocolVersion: BROWSER_BRIDGE_PROTOCOL,
              commandID: command.id,
              operationID: command.operationId,
              runID: command.runID,
              completedAt: new Date().toISOString(),
              // Tests supply the actual observation for every page-bearing action.
              outcome: actionOutcome ??
                (target && input.outcomes?.[target]) ?? {
                  status: "completed",
                  snapshot: null,
                  observation: {
                    url: target ?? null,
                    title: null,
                    readyState: "complete",
                    window: {
                      recovered: false,
                      minimized: false,
                      onScreen: true,
                    },
                    screenRecording: "granted",
                    durationMs: 1,
                  },
                },
            },
          }),
        );
      if (input.delayMs) setTimeout(reply, input.delayMs);
      else reply();
    });
    socket.send(
      JSON.stringify({
        protocolVersion: BROWSER_BRIDGE_PROTOCOL,
        type: "hello",
        deviceID: input.deviceID ?? "11111111-1111-4111-8111-111111111111",
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
    if (input.initialForgetAck)
      socket.send(
        JSON.stringify({
          protocolVersion: BROWSER_BRIDGE_PROTOCOL,
          type: "forget_run_ack",
          ...input.initialForgetAck,
        }),
      );
    return new Response(null, { status: 202 });
  },
};
