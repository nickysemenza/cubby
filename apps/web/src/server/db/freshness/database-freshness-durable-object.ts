import type { WebSocket as CfWebSocket } from "@cloudflare/workers-types";
import { DurableObject } from "cloudflare:workers";

import { doorbellRing, type DatabaseChanges } from "~/lib/doorbell";
import {
  acceptDoorbell,
  refuseDoorbellMessage,
  ringDoorbell,
} from "~/server/http/doorbell-socket";

import type { DatabaseFreshnessRpc } from "./rpc";

/** Notification owner; the deployed class name preserves its namespace and sockets. */
export class DatabaseFreshnessDurableObject
  extends DurableObject<Env>
  implements DatabaseFreshnessRpc
{
  async fetch(request: Request): Promise<Response> {
    return acceptDoorbell(this.ctx, request);
  }

  async publishChanges(changes: DatabaseChanges): Promise<void> {
    const ring = doorbellRing.parse({
      type: "ring",
      topic: "household.changed",
      changes,
    });
    ringDoorbell(this.ctx, ring);
  }

  webSocketMessage(socket: CfWebSocket): void {
    refuseDoorbellMessage(socket);
  }

  webSocketError(socket: CfWebSocket): void {
    socket.close(1011, "Change subscription failed");
  }
}
