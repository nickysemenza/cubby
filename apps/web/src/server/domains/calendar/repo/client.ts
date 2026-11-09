import type { UserId } from "@cubby/schemas/identifiers";
import { createLogger } from "@cubby/worker-tracing";

import { getCalendarFeedNamespace, getExecutionCtx } from "~/server/cf-env";
import { withTrace } from "~/server/observability/tracing";
import { enqueueBackgroundTask } from "~/server/workflows/background-tasks/publish";

import { calDavProtocolResponse } from "./caldav-protocol";
import type { CalendarFeedState, CalendarCredentialState } from "./contracts";

const log = createLogger("calendar-feed");

type CalendarFeedStub = ReturnType<Env["CALENDAR_FEED"]["getByName"]>;

class RemoteCalendarFeedState
  implements CalendarFeedState, CalendarCredentialState
{
  constructor(
    private readonly origin: string,
    private readonly stub: CalendarFeedStub,
  ) {}

  clearUncertainWrite(
    ...args: Parameters<CalendarCredentialState["clearUncertainWrite"]>
  ) {
    return this.stub.clearUncertainWrite(...args);
  }
  getToken() {
    return this.stub.getToken();
  }

  getCalendarCredential(owner: UserId) {
    return this.stub.getCalendarCredential(owner);
  }
  rotateCalendarCredential(owner: UserId) {
    return this.stub.rotateCalendarCredential(owner, this.origin);
  }
  revokeCalendarCredential(owner: UserId) {
    return this.stub.revokeCalendarCredential(owner);
  }

  inspect() {
    return this.stub.inspect(this.origin);
  }

  rotate() {
    return this.stub.rotate(this.origin);
  }

  read(...args: Parameters<CalendarFeedState["read"]>) {
    return this.stub.read(...args);
  }

  markDirty(reason: string) {
    return this.stub.markDirty(reason, this.origin);
  }

  refreshNow(reason: string) {
    return this.stub.refreshNow(reason, this.origin);
  }
}

export async function calendarFeedStateFor(
  origin: string,
): Promise<CalendarFeedState & CalendarCredentialState> {
  const namespace = getCalendarFeedNamespace();
  if (!namespace)
    throw new Error("Calendar requires the Cloudflare Worker runtime");
  return new RemoteCalendarFeedState(
    origin,
    namespace.getByName(new URL(origin).hostname),
  );
}

/** External subscriptions never fall back to a database-backed local projection. */
export async function externalCalendarFeedStateFor(
  origin: string,
): Promise<CalendarFeedState | null> {
  const namespace = getCalendarFeedNamespace();
  return namespace
    ? new RemoteCalendarFeedState(
        origin,
        namespace.getByName(new URL(origin).hostname),
      )
    : null;
}

export async function handleCalDavRequest(request: Request): Promise<Response> {
  const early = calDavProtocolResponse(request);
  if (early) return early;
  const namespace = getCalendarFeedNamespace();
  if (!namespace)
    return new Response("Calendar requires the Cloudflare Worker runtime", {
      status: 503,
    });
  return withTrace("caldav.forward", async (span) => {
    const response = await namespace
      .getByName(new URL(request.url).hostname)
      .fetch(request);
    span.setAttribute("http.response.status_code", response.status);
    return response;
  });
}

/**
 * Db-less sender: this runs from a `waitUntil` with no request `Database` in
 * scope, and the task carries everything its handler needs. Without a queue
 * binding (plain Node) there is no calendar Durable Object either, so there is
 * nothing to fall back to.
 */
async function enqueueMarkDirtyFallback(
  origin: string,
  reason: string,
): Promise<void> {
  try {
    await enqueueBackgroundTask(
      {
        kind: "calendar-feed.mark-dirty",
        requestedAt: new Date().toISOString(),
        origin,
        reason,
      },
      { source: "calendar-feed.mark-dirty-fallback" },
    );
  } catch (error) {
    // SILENT: the last resort — the dirty mark and the queue both
    // failed inside a committed `waitUntil`, so there is no caller left to
    // report to. The feed stays stale until the next write re-marks it.
    log.error("failed to enqueue mark-dirty fallback", { reason, error });
  }
}

/** The feed origin a request addresses: its `Origin`, else its forwarded host. */
export function calendarFeedOrigin(headers: Headers): string | undefined {
  const origin = headers.get("origin");
  if (origin) return new URL(origin).origin;
  const host = headers.get("host");
  if (!host) return undefined;
  const protocol =
    headers.get("x-forwarded-proto") ??
    (host.startsWith("localhost") ? "http" : "https");
  return `${protocol}://${host}`;
}

export function scheduleCalendarFeedDirty(
  reason: string,
  options: { origin?: string } = {},
): void {
  const execution = getExecutionCtx();
  const origin = execution?.origin ?? options.origin;
  if (!origin || !getCalendarFeedNamespace()) return;
  // `markDirty` only sets a flag, so a failed mark hands the same idempotent
  // mark to the durable queue (`calendar-feed.mark-dirty`) rather than leaving
  // the feed stale; the response is already committed.
  const task = (async () => {
    try {
      await (await calendarFeedStateFor(origin)).markDirty(reason);
    } catch (error) {
      log.error("failed to mark snapshot dirty", { reason, error });
      await enqueueMarkDirtyFallback(origin, reason);
    }
  })();
  execution?.waitUntil(task);
}
