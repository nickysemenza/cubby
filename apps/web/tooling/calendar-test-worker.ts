import { CalendarFeedDurableObject } from "~/server/calendar/durable-object";

export { CalendarFeedDurableObject };

/**
 * The Worker pool exercises the production Durable Object class through its
 * normal HTTP entrypoint. Production routing has unrelated application
 * bindings, so this deliberately narrow entrypoint keeps calendar tests
 * hermetic while preserving the actual DO runtime and SQLite storage.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const object = env.CALENDAR_FEED.getByName(new URL(request.url).hostname);
    return await object.fetch(request);
  },
};

export { DatabaseFreshnessDurableObject } from "~/server/database-freshness/durable-object";
export { PurchaseImportDurableObject } from "~/server/purchase-import/durable-object";
export { AiResponseCacheDurableObject } from "~/server/ai/response-cache-durable-object";
