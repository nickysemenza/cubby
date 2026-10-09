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
    if (new URL(request.url).pathname === "/chatgpt/authorize") {
      try {
        const plan = env.CHATGPT_PLAN.getByName(new URL(request.url).hostname);
        return Response.json(await plan.authorizePlan(await request.json()));
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 400 });
      }
    }
    const object = env.CALENDAR_FEED.getByName(new URL(request.url).hostname);
    return await object.fetch(request);
  },
};

export { DatabaseFreshnessDurableObject } from "~/server/database-freshness/durable-object";
export { PurchaseImportDurableObject } from "~/server/purchase-import/durable-object";
export { AiResponseCacheDurableObject } from "~/server/ai/response-cache-durable-object";
export { ChatGptPlanDurableObject } from "~/server/ai/chatgpt/durable-object";
export { UsdaReleaseDurableObject } from "~/server/usda-release/durable-object";
