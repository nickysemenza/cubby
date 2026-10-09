import type {
  DurableObjectState,
  WebSocket as CfWebSocket,
} from "@cloudflare/workers-types";
import {
  BROWSER_BRIDGE_PROTOCOL,
  type browserBridgeClientMessage,
  purchaseAgentEvent,
  type BrowserBridgeRequest,
} from "@cubby/schemas/purchase-import";
import { createLogger } from "@cubby/worker-tracing";
import { DurableObject } from "cloudflare:workers";
import { z } from "zod";

import {
  assertNotInMaintenance,
  isMaintenanceMode,
  maintenanceResponse,
} from "~/server/maintenance";

import {
  bridgeServerMessage,
  decodeBrowserBridgeMessage,
  type BrowserBridgeResult,
  type PurchaseImportDurableObjectRpc,
} from "./contracts";
import { PurchaseImportSqlStore, type RunCompletionSummary } from "./sql-store";

const log = createLogger("purchase-import.bridge");

declare const WebSocketPair: {
  new (): { 0: WebSocket; 1: CfWebSocket };
};

const socketAttachment = z.object({
  protocolVersion: z.literal(BROWSER_BRIDGE_PROTOCOL),
  ledgerPartyId: z.string(),
  vendorAccountId: z.string(),
  userId: z.string(),
  deviceID: z.uuid().toLowerCase().optional(),
});
type SocketAttachment = z.infer<typeof socketAttachment>;

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
    if (this.closeForMaintenance()) return maintenanceResponse(request);
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
      protocolVersion: BROWSER_BRIDGE_PROTOCOL,
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
    this.requireActive();
    const persisted = this.store.enqueue(command);
    this.broadcastNext(persisted.id);
  }

  async forgetRun(input: {
    runId: string;
    receiptId: string;
  }): Promise<{ forgotten: boolean }> {
    this.requireActive();
    const parsed = z
      .object({
        runId: z.uuid().toLowerCase(),
        receiptId: z.uuid().toLowerCase(),
      })
      .parse(input);
    // External member-owned receipt authorizes physical erasure before any
    // broker lookup. Never initialize the disposed coordinator to authorize it.
    const { runServicesFor } = await import("./agent-services");
    await runServicesFor(
      this.env,
      this.ctx,
      parsed.runId,
    ).authorizeResearchRetirement(parsed.receiptId);
    const result = this.store.forgetRun(parsed.runId, parsed.receiptId);
    for (const socket of this.ctx.getWebSockets()) this.sendForgets(socket);
    return result;
  }

  async result(requestId: string): Promise<BrowserBridgeResult | null> {
    return this.store.result(requestId);
  }

  async cancel(requestId: string): Promise<void> {
    this.requireActive();
    this.store.cancel(requestId);
    this.broadcastMessage({
      protocolVersion: BROWSER_BRIDGE_PROTOCOL,
      type: "cancel",
      commandID: requestId,
    });
    this.broadcastNext();
  }

  async connected(): Promise<boolean> {
    if (this.closeForMaintenance()) return false;
    return this.ctx
      .getWebSockets()
      .some((socket) => this.attachment(socket)?.deviceID !== undefined);
  }

  async pendingCommands(
    runID: string,
  ): Promise<Array<{ requestId: string; createdAt: number }>> {
    return this.store.pendingCommands(runID);
  }

  async notifyRunCompleted(summary: RunCompletionSummary): Promise<void> {
    this.requireActive();
    if (this.store.isRetired(summary.runID)) return;
    this.store.saveRunCompletion(summary);
    for (const socket of this.ctx.getWebSockets())
      this.sendCompletion(socket, summary);
  }

  async requestAuthentication(runID: string): Promise<void> {
    this.requireActive();
    if (this.store.isRetired(runID)) return;
    this.broadcastMessage({
      protocolVersion: BROWSER_BRIDGE_PROTOCOL,
      type: "raise_auth_window",
      runID,
    });
  }

  async webSocketMessage(
    socket: CfWebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    if (this.closeForMaintenance()) return;
    const parsed = decodeBrowserBridgeMessage(message);
    if (!parsed.success) {
      log.error("invalid-message", {
        issues: parsed.error.issues.map((issue) => ({
          code: issue.code,
          path: issue.path.join("."),
        })),
      });
      socket.close(1008, "Invalid or obsolete bridge protocol");
      return;
    }
    const attachment = this.attachment(socket);
    if (!attachment) {
      socket.close(1008, "Authenticated ownership context required");
      return;
    }
    await this.processMessage(socket, parsed.data, attachment);
  }

  private async processMessage(
    socket: CfWebSocket,
    data: z.output<typeof browserBridgeClientMessage>,
    attachment: SocketAttachment,
  ): Promise<void> {
    if (data.type === "hello") {
      if (attachment.deviceID && attachment.deviceID !== data.deviceID) {
        socket.close(1008, "Bridge device identity changed");
        return;
      }
      socket.serializeAttachment({
        ...attachment,
        deviceID: data.deviceID,
      } satisfies SocketAttachment);
      for (const other of this.ctx.getWebSockets()) {
        if (other !== socket) other.close(1000, "Replaced by newer connection");
      }
      this.sendForgets(socket);
      this.sendNext(socket);
      for (const summary of this.store.pendingRunCompletions())
        this.sendCompletion(socket, summary);
      const pending = this.store.nextReplayable();
      if (pending) {
        await this.publish({
          version: 1,
          type: "browser_connected",
          runId: pending.runID,
          eventId: `browser-connected:${pending.id}`,
          connectionId: data.deviceID,
        });
        return;
      }
      // Nothing to replay, but a run paused on a failed step (a permission
      // the member just granted, a window brought back) resumes now.
      const wake = this.store.nextWake();
      if (wake) {
        await this.publish({
          version: 1,
          type: "browser_connected",
          runId: wake.runId,
          eventId: `browser-connected:wake:${wake.runId}:${wake.generation}`,
          connectionId: data.deviceID,
        });
        this.store.forgetWake(wake.runId, wake.generation);
      }
      return;
    }
    if (!attachment.deviceID) {
      socket.close(1008, "Bridge hello required");
      return;
    }
    if (data.type === "forget_run_ack") {
      this.acknowledgeForget(socket, data, attachment.deviceID);
      return;
    }
    if (data.type === "run_completed_ack") {
      this.store.acknowledgeRunCompletion(data.runID);
      return;
    }
    if (data.type === "result") {
      const claimed = this.store.claimResult(data.result);
      if (claimed.command && claimed.newlyCompleted) {
        if (data.result.outcome.status === "failed")
          this.store.rememberWake(data.result.runID);
        else this.store.forgetWake(data.result.runID);
      }
      if (claimed.command && claimed.newlyCompleted) {
        // Publish before acknowledgement. If queue publication fails, the Mac
        // retains and replays its result; the stable event id makes that replay
        // harmless after a successful publication.
        await this.publish({
          version: 1,
          type: "browser_result",
          runId: data.result.runID,
          eventId: `browser-result:${data.result.commandID}`,
          commandId: data.result.commandID,
        });
      }
      socket.send(
        JSON.stringify(
          bridgeServerMessage.parse({
            protocolVersion: BROWSER_BRIDGE_PROTOCOL,
            type: "acknowledge",
            commandID: data.result.commandID,
          }),
        ),
      );
      this.sendNext(socket, data.result.commandID);
    }
  }

  webSocketError(_socket: CfWebSocket, error: Error): void {
    log.error("websocket", { error });
  }

  webSocketClose(
    _socket: CfWebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): void {
    // The socket is already closed. Calling close again can attempt to send reserved code 1006.
  }

  private broadcastNext(expectedId?: string): void {
    if (this.closeForMaintenance()) return;
    const next = this.store.nextReplayable();
    if (!next || (expectedId && next.id !== expectedId)) return;
    for (const socket of this.ctx.getWebSockets()) this.send(socket, next);
  }

  private sendNext(socket: CfWebSocket, justCompletedId?: string): void {
    if (this.closeForMaintenance()) return;
    const next = this.store.nextReplayable();
    if (!next) return;
    if (next.id === justCompletedId) {
      // A completed side effect must never be dispatched again, even if a
      // runtime/storage regression briefly exposes a stale replay row. The
      // Mac has already persisted the result and will replay it on reconnect.
      log.error("completed-command-replay", {
        commandId: next.id,
      });
      return;
    }
    this.send(socket, next);
  }

  private send(socket: CfWebSocket, command: BrowserBridgeRequest): void {
    if (this.closeForMaintenance()) return;
    const device = this.attachment(socket)?.deviceID;
    if (!device) return;
    this.store.recordDelivery(command.id, device);
    socket.send(
      JSON.stringify(
        bridgeServerMessage.parse({
          protocolVersion: BROWSER_BRIDGE_PROTOCOL,
          type: "command",
          command,
        }),
      ),
    );
    this.store.markSent(command.id);
  }

  private closeForMaintenance(): boolean {
    if (!isMaintenanceMode(this.env)) return false;
    // No result ACK: the native client retains its bytes for reconnect/replay.
    for (const socket of this.ctx.getWebSockets())
      socket.close(1012, "Cubby maintenance; reconnect after cutover");
    return true;
  }

  private requireActive(): void {
    if (this.closeForMaintenance()) assertNotInMaintenance(this.env);
  }

  private acknowledgeForget(
    socket: CfWebSocket,
    message: Extract<
      z.infer<typeof browserBridgeClientMessage>,
      { type: "forget_run_ack" }
    >,
    deviceID: string,
  ): void {
    if (message.deviceID !== deviceID) {
      socket.close(1008, "Erasure acknowledgement device mismatch");
      return;
    }
    this.store.acknowledgeForget(message.runID, message.retirementID, deviceID);
  }

  private attachment(socket: CfWebSocket): SocketAttachment | null {
    const parsed = socketAttachment.safeParse(socket.deserializeAttachment());
    return parsed.success ? parsed.data : null;
  }

  private sendForgets(socket: CfWebSocket): void {
    const device = this.attachment(socket)?.deviceID;
    if (!device) return;
    for (const pending of this.store.pendingForgets(device))
      socket.send(
        JSON.stringify(
          bridgeServerMessage.parse({
            protocolVersion: BROWSER_BRIDGE_PROTOCOL,
            type: "forget_run",
            runID: pending.runId,
            retirementID: pending.receiptId,
          }),
        ),
      );
  }

  private sendCompletion(
    socket: CfWebSocket,
    summary: RunCompletionSummary,
  ): void {
    const device = this.attachment(socket)?.deviceID;
    if (!device || this.store.isRetired(summary.runID)) return;
    this.store.recordRunDelivery(summary.runID, device);
    socket.send(
      JSON.stringify(
        bridgeServerMessage.parse({
          protocolVersion: BROWSER_BRIDGE_PROTOCOL,
          type: "run_completed",
          ...summary,
        }),
      ),
    );
  }

  private broadcastMessage(message: unknown): void {
    const encoded = JSON.stringify(bridgeServerMessage.parse(message));
    for (const socket of this.ctx.getWebSockets())
      if (this.attachment(socket)?.deviceID) socket.send(encoded);
  }

  private async publish(
    event: z.input<typeof purchaseAgentEvent>,
  ): Promise<void> {
    await this.env.PURCHASE_AGENT_QUEUE.send(purchaseAgentEvent.parse(event));
  }
}
