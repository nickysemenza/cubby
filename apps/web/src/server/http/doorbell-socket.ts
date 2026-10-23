import type {
  DurableObjectState,
  WebSocket as CfWebSocket,
} from "@cloudflare/workers-types";

import type { DoorbellRing } from "~/lib/doorbell";

// The owning Durable Objects import this half; the Worker-side upgrade in
// ./doorbell imports Auth and the database, which a Durable Object bundle
// must not load.

declare const WebSocketPair: { new (): { 0: WebSocket; 1: CfWebSocket } };

/** A subscriber reconnects (and authenticates again) at least this often. */
const SUBSCRIPTION_TTL_MS = 5 * 60_000;

/** Accept one hibernating subscriber; it never sends anything back. */
export function acceptDoorbell(
  ctx: DurableObjectState,
  request: Request,
): Response {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
    return new Response("WebSocket upgrade required", { status: 426 });
  const { 0: client, 1: server } = new WebSocketPair();
  ctx.acceptWebSocket(server);
  server.serializeAttachment(Date.now() + SUBSCRIPTION_TTL_MS);
  // SAFETY: Cloudflare extends ResponseInit for WebSocket upgrades.
  return new Response(null, {
    status: 101,
    webSocket: client,
  } as ResponseInit & { webSocket: WebSocket });
}

/** Ring every live subscriber; returns how many were reached. */
export function ringDoorbell(
  ctx: DurableObjectState,
  ring: DoorbellRing,
): number {
  const payload = JSON.stringify(ring);
  let reached = 0;
  for (const socket of ctx.getWebSockets()) {
    const expiresAt: unknown = socket.deserializeAttachment();
    if (typeof expiresAt !== "number" || expiresAt <= Date.now()) {
      socket.close(1008, "Reconnect to authenticate again");
      continue;
    }
    try {
      socket.send(payload);
      reached += 1;
    } catch {
      // SILENT: a disconnected subscriber must not block delivery to other peers.
    }
  }
  return reached;
}

/** Subscribers only listen; anything they send ends the subscription. */
export function refuseDoorbellMessage(socket: CfWebSocket): void {
  socket.close(1008, "This subscription is read-only");
}
