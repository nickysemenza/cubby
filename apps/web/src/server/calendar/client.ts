import type { UserId } from "@cubby/schemas/identifiers";

import { getCalendarFeedNamespace, getExecutionCtx } from "~/server/cf-env";
import type { Database } from "~/server/db";

import type { CalendarFeedState, CalendarCredentialState } from "./contracts";

type CalendarFeedStub = ReturnType<Env["CALENDAR_FEED"]["getByName"]>;

class RemoteCalendarFeedState
  implements CalendarFeedState, CalendarCredentialState
{
  constructor(
    private readonly origin: string,
    private readonly stub: CalendarFeedStub,
  ) {}

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
  db?: Database,
): Promise<CalendarFeedState & CalendarCredentialState> {
  const namespace = getCalendarFeedNamespace();
  if (namespace) {
    const hostname = new URL(origin).hostname;
    return new RemoteCalendarFeedState(origin, namespace.getByName(hostname));
  }
  const { getInMemoryCalendarFeedState } = await import("./local-state");
  const state = getInMemoryCalendarFeedState(origin, db);
  return Object.assign(state, {
    getCalendarCredential: async (_owner: UserId) => ({
      configured: false,
      username: "",
      createdAt: null,
    }),
    rotateCalendarCredential: async (
      _owner: UserId,
    ): Promise<{ username: string; password: string; createdAt: string }> => {
      throw new Error(
        "Calendar app passwords require the Cloudflare Worker runtime",
      );
    },
    revokeCalendarCredential: async (_owner: UserId) => {
      throw new Error(
        "Calendar app passwords require the Cloudflare Worker runtime",
      );
    },
  });
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
  options: { origin?: string; db?: Database } = {},
): void {
  const execution = getExecutionCtx();
  const origin = execution?.origin ?? options.origin;
  if (!origin) return;
  const task = calendarFeedStateFor(origin, options.db)
    .then(async (state) => await state.markDirty(reason))
    .catch((error) => {
      console.error("[calendar-feed] failed to mark snapshot dirty", error);
    });
  execution?.waitUntil(task);
}
