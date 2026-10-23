import type { DurableObjectState } from "@cloudflare/workers-types";
import { DurableObject } from "cloudflare:workers";

import { databaseChangeMessage } from "~/lib/database-changes";
import {
  databaseFreshness,
  type DatabaseFreshnessRpc,
} from "~/server/db/freshness/state";

import { DatabaseFreshnessStore } from "../repo/database-freshness-store";

declare const WebSocketPair: {
  new (): { 0: WebSocket; 1: import("@cloudflare/workers-types").WebSocket };
};

/** One timestamp per database environment, shared by every household client. */
export class DatabaseFreshnessDurableObject
  extends DurableObject<Env>
  implements DatabaseFreshnessRpc
{
  private readonly store: DatabaseFreshnessStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new DatabaseFreshnessStore(ctx.storage);
    void ctx.blockConcurrencyWhile(async () => {
      await this.store.migrate();
      await ctx.storage.deleteAlarm();
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
      return new Response("WebSocket upgrade required", { status: 426 });
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(Date.now() + 5 * 60_000);
    // SAFETY: Cloudflare extends ResponseInit for WebSocket upgrades.
    return new Response(null, {
      status: 101,
      webSocket: client,
    } as ResponseInit & { webSocket: WebSocket });
  }

  async publishChanges(categories: string[]): Promise<void> {
    const message = databaseChangeMessage.parse({
      type: "invalidate",
      categories,
    });
    // Notification-triggered reads must bypass Hyperdrive's bounded-stale cache.
    await this.recordWrite();
    const payload = JSON.stringify(message);
    for (const socket of this.ctx.getWebSockets()) {
      const expiresAt: unknown = socket.deserializeAttachment();
      if (typeof expiresAt !== "number" || expiresAt <= Date.now()) {
        socket.close(1008, "Reconnect to authenticate again");
        continue;
      }
      try {
        socket.send(payload);
      } catch {
        // SILENT: a disconnected subscriber must not block delivery to other peers.
      }
    }
  }

  webSocketMessage(
    socket: import("@cloudflare/workers-types").WebSocket,
  ): void {
    socket.close(1008, "This subscription is read-only");
  }

  webSocketError(socket: import("@cloudflare/workers-types").WebSocket): void {
    socket.close(1011, "Change subscription failed");
  }

  readFreshness() {
    return databaseFreshness(this.store.read());
  }

  async recordWrite() {
    return databaseFreshness(this.store.recordWrite());
  }
}
