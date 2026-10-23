import type {
  DurableObjectState,
  WebSocket as CfWebSocket,
} from "@cloudflare/workers-types";
import { DurableObject } from "cloudflare:workers";

import { doorbellRing } from "~/lib/doorbell";
import {
  databaseFreshness,
  type DatabaseFreshnessRpc,
} from "~/server/db/freshness/state";
import {
  acceptDoorbell,
  refuseDoorbellMessage,
  ringDoorbell,
} from "~/server/http/doorbell-socket";

import { DatabaseFreshnessStore } from "../repo/database-freshness-store";

/**
 * One timestamp per database environment, shared by every household client,
 * and the owner of the `household.changed` doorbell.
 */
export class DatabaseFreshnessDurableObject
  extends DurableObject<Env>
  implements DatabaseFreshnessRpc
{
  private readonly store: DatabaseFreshnessStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new DatabaseFreshnessStore(ctx.storage);
    void ctx.blockConcurrencyWhile(() => this.store.migrate());
  }

  async fetch(request: Request): Promise<Response> {
    return acceptDoorbell(this.ctx, request);
  }

  async publishChanges(categories: string[]): Promise<void> {
    const ring = doorbellRing.parse({
      type: "ring",
      topic: "household.changed",
      categories,
    });
    // Notification-triggered reads must bypass Hyperdrive's bounded-stale cache.
    await this.recordWrite();
    ringDoorbell(this.ctx, ring);
  }

  webSocketMessage(socket: CfWebSocket): void {
    refuseDoorbellMessage(socket);
  }

  webSocketError(socket: CfWebSocket): void {
    socket.close(1011, "Change subscription failed");
  }

  readFreshness() {
    return databaseFreshness(this.store.read());
  }

  async recordWrite() {
    return databaseFreshness(this.store.recordWrite());
  }
}
