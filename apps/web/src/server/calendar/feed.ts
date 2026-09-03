import type { CalendarFeedState } from "./contracts";
import { parseCalendarFeedRequest } from "./contracts";

const notFound = () =>
  new Response("Not found", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });

const responseHeaders = (
  feed: "meals" | "tasks" | "all",
  result: {
    etag: string;
    generatedAt: string;
    revision: number;
    itemCount: number;
  },
) => ({
  "Content-Type": "text/calendar; charset=utf-8",
  "Content-Disposition": `inline; filename="cubby-${feed}.ics"`,
  "Cache-Control": "private, max-age=900",
  ETag: result.etag,
  "Last-Modified": new Date(result.generatedAt).toUTCString(),
  "X-Cubby-Calendar-Revision": String(result.revision),
  "X-Cubby-Calendar-Items": String(result.itemCount),
});

export type CalendarFeedStateResolver = (
  origin: string,
) => Promise<CalendarFeedState>;

export const createCalendarFeedHandler =
  (stateForOrigin: CalendarFeedStateResolver) =>
  async ({ request }: { request: Request }) => {
    const url = new URL(request.url);
    const parsed = parseCalendarFeedRequest(url);
    if (!parsed) return notFound();

    const state = await stateForOrigin(url.origin);
    const result = await state.read(
      parsed.token,
      parsed.feed,
      request.headers.get("if-none-match"),
    );
    if (result.result === "not_found") return notFound();
    const headers = responseHeaders(parsed.feed, result);
    if (result.result === "not_modified") {
      return new Response(null, { status: 304, headers });
    }
    return new Response(result.body, { status: 200, headers });
  };
