import type {
  DurableObjectState,
  WebSocket as CfWebSocket,
} from "@cloudflare/workers-types";
import {
  purchaseAgentEvent,
  type BrowserBridgeRequest,
} from "@cubby/schemas/purchase-import";
import { DurableObject } from "cloudflare:workers";
import { z } from "zod";

import {
  bridgeServerMessage,
  decodeBrowserBridgeMessage,
  type BrowserBridgeResult,
  type PurchaseImportDurableObjectRpc,
} from "./contracts";
import { PurchaseImportSqlStore, type RunCompletionSummary } from "./sql-store";

declare const WebSocketPair: {
  new (): { 0: WebSocket; 1: CfWebSocket };
};

type SocketAttachment = {
  protocolVersion: 2;
  ledgerPartyId: string;
  vendorAccountId: string;
  userId: string;
};

export class PurchaseImportDurableObject
  extends DurableObject<Env>
  implements PurchaseImportDurableObjectRpc
{
  private readonly store: PurchaseImportSqlStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new PurchaseImportSqlStore(ctx.storage);
    this.store.migrate();
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
      return new Response("WebSocket upgrade required", { status: 426 });
    const ledgerPartyId = request.headers.get("x-cubby-ledger-party-id");
    const vendorAccountId = request.headers.get("x-cubby-vendor-account-id");
    const userId = request.headers.get("x-cubby-user-id");
    if (!ledgerPartyId || !vendorAccountId || !userId)
      return new Response("Authenticated ownership context required", {
        status: 403,
      });

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({
      protocolVersion: 2,
      ledgerPartyId,
      vendorAccountId,
      userId,
    } satisfies SocketAttachment);
    // SAFETY: Cloudflare extends ResponseInit with the WebSocket upgrade slot.
    const responseInit = {
      status: 101,
      webSocket: client,
    } as ResponseInit & { webSocket: WebSocket };
    return new Response(null, responseInit);
  }

  async enqueue(command: BrowserBridgeRequest): Promise<void> {
    const persisted = this.store.enqueue(command);
    this.broadcastNext(persisted.id);
  }

  async result(requestId: string): Promise<BrowserBridgeResult | null> {
    return this.store.result(requestId);
  }

  async cancel(requestId: string): Promise<void> {
    this.store.cancel(requestId);
    this.broadcastMessage({
      protocolVersion: 2,
      type: "cancel",
      commandID: requestId,
    });
    this.broadcastNext();
  }

  async connected(): Promise<boolean> {
    return this.ctx.getWebSockets().length > 0;
  }

  async notifyRunCompleted(summary: RunCompletionSummary): Promise<void> {
    this.store.saveRunCompletion(summary);
    this.broadcastMessage({
      protocolVersion: 2,
      type: "run_completed",
      ...summary,
    });
  }

  async requestAuthentication(runID: string): Promise<void> {
    this.broadcastMessage({
      protocolVersion: 2,
      type: "raise_auth_window",
      runID,
    });
  }

  async webSocketMessage(
    socket: CfWebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    const parsed = decodeBrowserBridgeMessage(message);
    if (!parsed.success) {
      socket.close(1008, "Invalid or obsolete bridge protocol");
      return;
    }
    if (parsed.data.type === "hello") {
      for (const other of this.ctx.getWebSockets()) {
        if (other !== socket) other.close(1000, "Replaced by newer connection");
      }
      this.sendNext(socket);
      for (const summary of this.store.pendingRunCompletions()) {
        socket.send(
          JSON.stringify(
            bridgeServerMessage.parse({
              protocolVersion: 2,
              type: "run_completed",
              ...summary,
            }),
          ),
        );
      }
      const pending = this.store.nextReplayable();
      if (pending) {
        await this.publish({
          version: 1,
          type: "browser_connected",
          runId: pending.runID,
          eventId: `browser-connected:${pending.id}`,
          connectionId: parsed.data.deviceID,
        });
      }
      return;
    }
    if (parsed.data.type === "run_completed_ack") {
      this.store.acknowledgeRunCompletion(parsed.data.runID);
      return;
    }
    if (parsed.data.type === "result") {
      const claimed = this.store.claimResult(parsed.data.result);
      if (claimed.command) {
        // Publish before acknowledgement. If queue publication fails, the Mac
        // retains and replays its result; the stable event id makes that replay
        // harmless after a successful publication.
        await this.publish({
          version: 1,
          type: "browser_result",
          runId: parsed.data.result.runID,
          eventId: `browser-result:${parsed.data.result.commandID}`,
          commandId: parsed.data.result.commandID,
        });
      }
      socket.send(
        JSON.stringify(
          bridgeServerMessage.parse({
            protocolVersion: 2,
            type: "acknowledge",
            commandID: parsed.data.result.commandID,
          }),
        ),
      );
      this.sendNext(socket);
    }
  }

  webSocketError(_socket: CfWebSocket, error: Error): void {
    console.error("purchase-import.bridge.websocket", error);
  }

  webSocketClose(
    socket: CfWebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ): void {
    const safeCode = code === 1006 ? 1000 : code;
    socket.close(safeCode, wasClean ? reason : "Bridge disconnected");
  }

  private broadcastNext(expectedId?: string): void {
    const next = this.store.nextReplayable();
    if (!next || (expectedId && next.id !== expectedId)) return;
    for (const socket of this.ctx.getWebSockets()) this.send(socket, next);
  }

  private sendNext(socket: CfWebSocket): void {
    const next = this.store.nextReplayable();
    if (next) this.send(socket, next);
  }

  private send(socket: CfWebSocket, command: BrowserBridgeRequest): void {
    socket.send(
      JSON.stringify(
        bridgeServerMessage.parse({
          protocolVersion: 2,
          type: "command",
          command,
        }),
      ),
    );
    this.store.markSent(command.id);
  }

  private broadcastMessage(message: unknown): void {
    const encoded = JSON.stringify(bridgeServerMessage.parse(message));
    for (const socket of this.ctx.getWebSockets()) socket.send(encoded);
  }

  private async publish(
    event: z.input<typeof purchaseAgentEvent>,
  ): Promise<void> {
    await this.env.PURCHASE_AGENT_QUEUE.send(purchaseAgentEvent.parse(event));
  }
}
