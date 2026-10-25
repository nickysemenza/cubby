import type { WebSocket as CfWebSocket } from "@cloudflare/workers-types";
import { DurableObject } from "cloudflare:workers";

import {
  acceptDoorbell,
  refuseDoorbellMessage,
  ringDoorbell,
} from "~/server/http/doorbell-socket";

import type { ImageProcessingCompanionRpc } from "../repo/companion-rpc";

/**
 * Owner of the `imageProcessing.work` doorbell. Postgres job state and leases
 * decide what is executable; a ring only tells companions to call
 * `imageProcessing.pull`, which claims, leases and assigns the work.
 */
export class ImageProcessingDurableObject
  extends DurableObject<Env>
  implements ImageProcessingCompanionRpc
{
  async fetch(request: Request): Promise<Response> {
    // Parked device work waits for any device: a new connection pulls at once.
    return acceptDoorbell(this.ctx, request, {
      type: "ring",
      topic: "imageProcessing.work",
    });
  }

  async ring(): Promise<number> {
    return ringDoorbell(this.ctx, {
      type: "ring",
      topic: "imageProcessing.work",
    });
  }

  webSocketMessage(socket: CfWebSocket): void {
    refuseDoorbellMessage(socket);
  }

  webSocketError(socket: CfWebSocket): void {
    socket.close(1011, "Image-processing subscription failed");
  }
}
