import type { UserId } from "@cubby/schemas/identifiers";

import { getCalendarFeedNamespace, getExecutionCtx } from "~/server/cf-env";

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
  const namespace = getCalendarFeedNamespace();
  if (!namespace)
    return new Response("Calendar requires the Cloudflare Worker runtime", {
      status: 503,
    });
  return namespace.getByName(new URL(request.url).hostname).fetch(request);
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
  // left to report into. A failure here leaves the calendar feed stale
  // until the next write successfully re-marks it dirty (known gap, see
  // docs/todos.md).
  const task = calendarFeedStateFor(origin)
    .then(async (state) => await state.markDirty(reason))
    .catch((error) => {
      console.error("[calendar-feed] failed to mark snapshot dirty", error);
    });
  execution?.waitUntil(task);
}
