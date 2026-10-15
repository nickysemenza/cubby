import { CalDavError, type CalDavCollection } from "./caldav-types";

export const CALDAV_BASE = "/api/caldav";
// Calendar.app omits DELETE preconditions. Deletion remains in Cubby.
export const CALDAV_METHODS = [
  "OPTIONS",
  "PROPFIND",
  "REPORT",
  "GET",
  "HEAD",
  "PUT",
];
export const CALDAV_ALLOW = CALDAV_METHODS.join(", ");
export type CalDavTarget =
  | { root: "base" | "principal" | "home" }
  | { root: "collection"; collection: CalDavCollection }
  | { root: "resource"; collection: CalDavCollection; filename: string };

export function calDavTarget(url: URL): CalDavTarget | null {
  const suffix =
    url.pathname.startsWith(`${CALDAV_BASE}/`) || url.pathname === CALDAV_BASE
      ? url.pathname.slice(CALDAV_BASE.length).replace(/\/+$/, "") || "/"
      : null;
  if (suffix === "/") return { root: "base" };
  if (suffix === "/principals/me") return { root: "principal" };
  if (suffix === "/calendars/me") return { root: "home" };
  if (suffix === null) return null;
  const match =
    /^\/calendars\/me\/(tasks|completed-tasks|meals)(?:\/([^/]+))?$/.exec(
      suffix,
    );
  if (!match) return null;
  const collection = match[1];
  if (
    collection !== "tasks" &&
    collection !== "completed-tasks" &&
    collection !== "meals"
  )
    return null;
  if (!match[2]) return { root: "collection", collection };
  let filename: string;
  try {
    filename = decodeURIComponent(match[2]);
  } catch (error) {
    if (error instanceof URIError)
      throw new CalDavError(400, "Invalid resource filename");
    throw error;
  }
  if (
    filename.includes("/") ||
    filename.includes("\\") ||
    Array.from(filename).some((character) => character.charCodeAt(0) < 32) ||
    filename.length > 255
  )
    throw new CalDavError(400, "Invalid resource filename");
  return { collection, filename, root: "resource" };
}

/** Stateless protocol responses shared by the Worker and DO HTTP adapter. */
export function calDavProtocolResponse(request: Request): Response | undefined {
  const url = new URL(request.url);
  // Rejections retain the DO's DAV error response rather than escaping as a
  // Worker exception or silently turning an invalid resource into OPTIONS.
  if (url.protocol !== "https:") return undefined;
  if (
    url.pathname === "/.well-known/caldav" ||
    url.pathname === "/.well-known/caldav/"
  )
    return Response.redirect(new URL(`${CALDAV_BASE}/`, url.origin), 308);
  if (request.method !== "OPTIONS") return undefined;
  try {
    if (!calDavTarget(url)) return undefined;
  } catch (error) {
    if (error instanceof CalDavError) return undefined;
    throw error;
  }
  return new Response(null, {
    status: 204,
    headers: {
      DAV: "1, calendar-access",
      Allow: CALDAV_ALLOW,
      "MS-Author-Via": "DAV",
    },
  });
}
