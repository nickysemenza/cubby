import { createHmac, timingSafeEqual } from "node:crypto";

import * as Sentry from "@sentry/cloudflare";
import { z } from "zod";

import { annotateActiveSpan } from "~/server/observability/tracing";

/**
 * Placement applies to the default fetch handler, not queue or scheduled events:
 * https://developers.cloudflare.com/workers/configuration/placement/#placement-behavior
 * Background events re-enter that handler through the `BACKGROUND_WORKER` self
 * binding so their database round trips start next to Postgres.
 */
export const PLACED_PATH = "/__internal/background";
const KEY_HEADER = "x-cubby-background";

// Service binding requests carry no caller identity a public request cannot
// forge, and the binding drops `props`, so the caller proves itself with a key
// derived from a secret both sides already hold.
const forwardKey = (env: Env) =>
  createHmac("sha256", env.BETTER_AUTH_SECRET)
    .update("cubby.background-forward")
    .digest("hex");

export const placedEventSchema = z.discriminatedUnion("event", [
  z.object({
    event: z.literal("queue"),
    queue: z.string(),
    bodies: z.array(z.unknown()),
  }),
  z.object({
    event: z.literal("scheduled"),
    cron: z.string(),
    scheduledTime: z.number(),
  }),
]);
export type PlacedEvent = z.infer<typeof placedEventSchema>;

export function isPlacedRequest(request: Request, env: Env) {
  const key = request.headers.get(KEY_HEADER);
  if (request.method !== "POST" || !key || !env.BETTER_AUTH_SECRET)
    return false;
  const actual = new TextEncoder().encode(key);
  const expected = new TextEncoder().encode(forwardKey(env));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Runs the event in the placed fetch handler. Returns null when the event must
 * run in this invocation instead: no binding (local dev, the workerd harness) or
 * a callee that refused the route (an old version, a key mismatch), so a bad
 * binding never stops background work. Any other failure throws, which is what
 * an in-place failure of the same event does.
 */
export async function forwardToPlaced(env: Env, event: PlacedEvent) {
  if (!env.BACKGROUND_WORKER) return null;
  const response = await env.BACKGROUND_WORKER.fetch(
    `https://internal${PLACED_PATH}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [KEY_HEADER]: forwardKey(env),
      },
      body: JSON.stringify(event),
    },
  );
  const placement = response.headers.get("cf-placement") ?? undefined;
  if (response.status === 404) {
    annotateActiveSpan({
      "cubby.forward": "fallback",
      "cloudflare.forwarded_placement": placement,
    });
    Sentry.captureException(
      new Error("Background forwarding refused; running in place"),
    );
    return null;
  }
  annotateActiveSpan({
    "cubby.forward": "placed",
    "cloudflare.forwarded_placement": placement,
  });
  if (!response.ok)
    throw new Error(`Background forwarding failed: ${response.status}`);
  return response;
}
