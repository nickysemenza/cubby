import type { UserId } from "@cubby/schemas/identifiers";

import { enqueueBackgroundTask } from "~/server/background-tasks/publish";
import { getCalendarFeedNamespace, getExecutionCtx } from "~/server/cf-env";
import { withTrace } from "~/server/tracing";

import { calDavProtocolResponse } from "./caldav-protocol";
import type { CalendarFeedState, CalendarCredentialState } from "./contracts";

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

/** Delays between dirty-mark attempts; the RPC is idempotent (`markDirty` only sets a flag). */
const DIRTY_MARK_RETRY_DELAYS_MS = [250, 750];

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
    // SILENT: the last resort — the in-request retries and the queue both
    // failed inside a committed `waitUntil`, so there is no caller left to
    // report to. The feed stays stale until the next write re-marks it.
    console.error(
      "[calendar-feed] failed to enqueue mark-dirty fallback",
      { reason },
      error,
    );
  }
}

export function scheduleCalendarFeedDirty(
  reason: string,
  options: { origin?: string } = {},
): void {
  const execution = getExecutionCtx();
  const origin = execution?.origin ?? options.origin;
  if (!origin || !getCalendarFeedNamespace()) return;
  // SILENT: best-effort background dirty-mark from a `waitUntil` task, run
  // after the response is already committed — there is no result channel
  // left to report into. `markDirty` only sets a flag on the target Durable
  // Object, so retrying it a few times (short backoff, still inside the same
  // `waitUntil`) is safe and absorbs a transient RPC failure; a failure that
  // survives every retry hands the same idempotent mark to the durable queue
  // (`calendar-feed.mark-dirty`) instead of leaving the feed stale.
  const task = (async () => {
    const state = await calendarFeedStateFor(origin);
    for (const [attempt, retryDelay] of [
      ...DIRTY_MARK_RETRY_DELAYS_MS,
      undefined,
    ].entries()) {
      try {
        await state.markDirty(reason);
        return;
      } catch (error) {
        if (retryDelay === undefined) {
          console.error(
            "[calendar-feed] failed to mark snapshot dirty",
            { reason, attempt },
            error,
          );
          await enqueueMarkDirtyFallback(origin, reason);
          return;
        }
        // SILENT: not the last attempt — logged above only if every retry
        // below also fails.
        await delay(retryDelay);
      }
    }
  })();
  execution?.waitUntil(task);
}
