import type { DurableObjectState } from "@cloudflare/workers-types";
import { DurableObject } from "cloudflare:workers";

import { databaseChangeMessage } from "~/lib/database-changes";
import {
  databaseFreshness,
  type DatabaseFreshnessRpc,
} from "~/server/db/freshness/state";

declare const WebSocketPair: {
  new (): { 0: WebSocket; 1: import("@cloudflare/workers-types").WebSocket };
};

/** One timestamp per database environment, shared by every household client. */
export class DatabaseFreshnessDurableObject
  extends DurableObject<Env>
  implements DatabaseFreshnessRpc
{
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS freshness (id INTEGER PRIMARY KEY CHECK (id = 1), last_write_at REAL NOT NULL)",
    );
    ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO freshness (id, last_write_at) VALUES (1, ?)",
      Date.now(),
    );
    // Problem counts are read directly now; drop the retired snapshot and any
    // refresh alarm an older deploy left behind.
    ctx.storage.sql.exec("DROP TABLE IF EXISTS problem_counts");
    void ctx.blockConcurrencyWhile(() => ctx.storage.deleteAlarm());
  }

  /** An older deploy's refresh alarm may fire before the constructor deletes it. */
  async alarm() {}

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
    const row = this.ctx.storage.sql
      .exec<{ last_write_at: number }>(
        "SELECT last_write_at FROM freshness WHERE id = 1",
      )
      .one();
    return databaseFreshness(row.last_write_at);
  }

  async recordWrite() {
    this.ctx.storage.sql.exec(
      "UPDATE freshness SET last_write_at = MAX(last_write_at, ?) WHERE id = 1",
      Date.now(),
    );
    return this.readFreshness();
  }
}
