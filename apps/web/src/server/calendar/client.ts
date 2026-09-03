import { getCalendarFeedNamespace, getExecutionCtx } from "~/server/cf-env";
import type { Database } from "~/server/db";

import type { CalendarFeedState } from "./contracts";

type CalendarFeedStub = ReturnType<Env["CALENDAR_FEED"]["getByName"]>;

class RemoteCalendarFeedState implements CalendarFeedState {
  constructor(
    private readonly origin: string,
    private readonly stub: CalendarFeedStub,
  ) {}

  getToken() {
    return this.stub.getToken();
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
): Promise<CalendarFeedState> {
  const namespace = getCalendarFeedNamespace();
  if (namespace) {
    const hostname = new URL(origin).hostname;
    return new RemoteCalendarFeedState(origin, namespace.getByName(hostname));
  }
  const { getInMemoryCalendarFeedState } = await import("./local-state");
  return getInMemoryCalendarFeedState(origin, db);
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
