import type {
  CalendarFeedDocumentInspection,
  CalendarFeedInspection,
} from "@cubby/schemas/calendar";
import type { UserId } from "@cubby/schemas/identifiers";

import type { CalDavCollection } from "./caldav-types";
import type { IcsFeed } from "./ics";

/**
 * Fixed UID namespace — deliberately NOT the serving origin.
 *
 * A UID identifies an event for the lifetime of a subscription, so it has to be
 * the same string no matter which host served the feed. Deriving it from the
 * request origin meant subscribing via localhost or a preview deploy and later
 * switching to production changed every UID, and Calendar.app treats a changed
 * UID as a brand-new event — so every meal and task would silently duplicate
 * instead of updating in place.
 *
 * Shared by the ICS serializer, the CalDAV write path's reserved-identity
 * guard, and the DO's synthetic fallback identity so all three agree on
 * exactly the namespace client-created resources cannot claim.
 */
export const UID_DOMAIN = "cubby.nickysemenza.com";

export interface CalendarCredentialState {
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
  ): Promise<{ username: string; password: string; createdAt: string }>;
  revokeCalendarCredential(owner: UserId): Promise<void>;
}

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

export interface CalendarFeedState {
  getToken(): Promise<string | null>;
  inspect(): Promise<CalendarFeedInspection>;
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

export function inspectCalendarDocument(
  document: StoredCalendarDocument | null | undefined,
): CalendarFeedDocumentInspection | null {
  if (!document) return null;
  return {
    etag: document.etag,
    generatedAt: document.generatedAt,
    revision: document.revision,
    itemCount: document.itemCount,
    byteLength: new TextEncoder().encode(document.body).byteLength,
  };
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
