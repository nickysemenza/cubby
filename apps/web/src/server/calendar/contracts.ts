import type { IcsFeed } from "./ics";

const CALENDAR_FEED_FILENAMES = {
  "meals.ics": "meals",
  "tasks.ics": "tasks",
  "all.ics": "all",
} as const satisfies Record<string, IcsFeed>;

const CALENDAR_FEED_PATH = /^\/api\/calendar\/([^/]+)\/([^/]+)\/?$/;

export interface StoredCalendarDocument {
  body: string;
  etag: string;
  generatedAt: string;
  revision: number;
  itemCount: number;
}

export type CalendarFeedReadResult =
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

export interface CalendarFeedState {
  getToken(): Promise<string | null>;
  rotate(): Promise<string>;
  read(
    token: string,
    feed: IcsFeed,
    ifNoneMatch: string | null,
  ): Promise<CalendarFeedReadResult>;
  markDirty(reason: string): Promise<void>;
  refreshNow(reason: string): Promise<CalendarRefreshResult | null>;
}

export interface CalendarFeedDurableObjectRpc {
  getToken(): Promise<string | null>;
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

export function createCalendarFeedToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function etagMatches(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false;
  return ifNoneMatch.split(",").some((candidate) => {
    const normalized = candidate.trim();
    return (
      normalized === "*" || normalized === etag || normalized === `W/${etag}`
    );
  });
}

export function parseCalendarFeedRequest(url: URL): {
  token: string;
  feed: IcsFeed;
} | null {
  const match = CALENDAR_FEED_PATH.exec(url.pathname);
  if (!match) return null;
  const [, rawToken, rawFilename] = match;
  if (!rawToken || !rawFilename) return null;
  if (!Object.hasOwn(CALENDAR_FEED_FILENAMES, rawFilename)) return null;
  // SAFETY: Object.hasOwn above proves the dynamic segment is a key of this
  // closed filename map before indexed access.
  const feed =
    CALENDAR_FEED_FILENAMES[
      rawFilename as keyof typeof CALENDAR_FEED_FILENAMES
    ];
  try {
    return { token: decodeURIComponent(rawToken), feed };
  } catch {
    return null;
  }
}
