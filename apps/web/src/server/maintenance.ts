import { z } from "zod";

/**
 * Cutover switch: while the `MAINTENANCE_MODE` Worker secret is `"true"`, the
 * web Worker answers every request with 503 and the daily cron skips, so no
 * writer runs against a database that is being migrated. Toggle it with
 * `wrangler secret put MAINTENANCE_MODE` / `wrangler secret delete
 * MAINTENANCE_MODE` (a secret change deploys a new version of the current
 * code). Queue consumers are not gated here: pause them with `wrangler queues
 * pause-delivery`, since unacked retries would spend the three-retry budget of
 * queues that have no dead-letter queue.
 */
/** An optional secret, so it is absent from the generated `Env` type and is
 * parsed out of the bindings instead. */
const maintenanceSwitch = z.object({ MAINTENANCE_MODE: z.string().optional() });

export function isMaintenanceMode(env: unknown): boolean {
  return maintenanceSwitch.safeParse(env).data?.MAINTENANCE_MODE === "true";
}

const RETRY_AFTER_SECONDS = "300";

export function maintenanceResponse(request: Request): Response {
  const url = new URL(request.url);
  const wantsJson =
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/_serverFn/") ||
    url.pathname.startsWith("/mcp") ||
    (request.headers.get("accept") ?? "").includes("application/json");
  const headers = {
    "retry-after": RETRY_AFTER_SECONDS,
    "cache-control": "no-store",
  };
  if (wantsJson)
    return Response.json(
      {
        error: {
          code: "MAINTENANCE",
          message: "Cubby is down for maintenance; try again in a few minutes.",
        },
      },
      { status: 503, headers },
    );
  return new Response(
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Cubby — maintenance</title><body style="font-family:system-ui;margin:3rem auto;max-width:32rem;padding:0 1rem"><h1>Down for maintenance</h1><p>Cubby is being upgraded. Try again in a few minutes.</p></body>',
    {
      status: 503,
      headers: { ...headers, "content-type": "text/html; charset=utf-8" },
    },
  );
}
