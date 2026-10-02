// Types only, importing nothing but schema types: the global
// worker-configuration.d.ts reaches this file through worker-bindings.ts, and
// tsc re-checks the whole program after an edit to anything it reaches
// (docs/local-check-performance.md#typechecking).
import type { CalendarFeedInspection } from "@cubby/schemas/calendar";
import type { UserId } from "@cubby/schemas/identifiers";

export type IcsFeed = "meals" | "tasks" | "all" | "garden";

/** `CALDAV_COLLECTIONS` in `caldav-types.ts` is keyed by exactly these. */
export type CalDavCollection = "tasks" | "completed-tasks" | "meals";

export interface StoredCalendarDocument {
  body: string;
  etag: string;
  generatedAt: string;
  revision: number;
  itemCount: number;
}

export type CalendarFeedReadResult =
  | { result: "unavailable" }
  | { result: "not_found" }
  | {
      result: "not_modified";
      etag: string;
      generatedAt: string;
      revision: number;
      itemCount: number;
    }
  | ({ result: "served" } & StoredCalendarDocument);

export interface CalendarRefreshResult {
  generatedAt: string;
  revision: number;
  counts: Record<IcsFeed, number>;
}

export interface CalendarFeedDurableObjectRpc {
  clearUncertainWrite(
    collection: CalDavCollection,
    filename: string,
  ): Promise<void>;
  getCalendarCredential(owner: UserId): Promise<{
    configured: boolean;
    username: string;
    createdAt: string | null;
  }>;
  rotateCalendarCredential(
    owner: UserId,
    origin: string,
  ): Promise<{ username: string; password: string; createdAt: string }>;
  revokeCalendarCredential(owner: UserId): Promise<void>;
  getToken(): Promise<string | null>;
  inspect(origin: string): Promise<CalendarFeedInspection>;
  rotate(origin: string): Promise<string>;
  read(
    token: string,
    feed: IcsFeed,
    ifNoneMatch: string | null,
  ): Promise<CalendarFeedReadResult>;
  markDirty(reason: string, origin: string): Promise<void>;
  refreshNow(
    reason: string,
    origin: string,
  ): Promise<CalendarRefreshResult | null>;
}
