import type {
  DurableObjectState,
  WebSocket as CfWebSocket,
} from "@cloudflare/workers-types";

import { type DoorbellRing, doorbellTopic } from "~/lib/doorbell";
import {
  getDatabaseFreshnessNamespace,
  getImageProcessingNamespace,
} from "~/server/cf-env";
import { createRequestContext } from "~/server/http/request-context";

declare const WebSocketPair: { new (): { 0: WebSocket; 1: CfWebSocket } };

/** A subscriber reconnects (and authenticates again) at least this often. */
const SUBSCRIPTION_TTL_MS = 5 * 60_000;

/** The Durable Object that owns each topic's subscribers. */
const topicOwner = {
  "household.changed": () =>
    getDatabaseFreshnessNamespace()?.getByName("household", {
      locationHint: "wnam",
    }),
  "imageProcessing.work": () =>
    getImageProcessingNamespace()?.getByName("household"),
} as const;

/**
 * Authenticate the upgrade once and hand it to the topic's owner. A cookie
 * credential must come from this origin; native clients send a bearer token.
 */
export async function handleDoorbellUpgrade(
  request: Request,
): Promise<Response> {
  if (request.method !== "GET")
    return new Response("Doorbell subscriptions use GET", { status: 405 });
  const topic = doorbellTopic.safeParse(
    new URL(request.url).searchParams.get("topic"),
  );
  if (!topic.success)
    return new Response(
      `Unknown doorbell topic; expected one of ${doorbellTopic.options.join(", ")}`,
      { status: 400 },
    );
  if (
    !request.headers.has("authorization") &&
    request.headers.get("origin") !== new URL(request.url).origin
  )
    return new Response("Same-origin subscription required", { status: 403 });
  const context = await createRequestContext({ headers: request.headers });
  if (!context.auth.userId || !context.actorContext)
    return new Response("Authentication required", { status: 401 });
  const owner = topicOwner[topic.data]();
  if (!owner)
    return new Response("Doorbell topic unavailable", { status: 503 });
  return owner.fetch(request);
}

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
