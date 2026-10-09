/**
 * The Worker pool exercises the production Durable Object classes — the entry
 * shells in `server/worker-entrypoints.ts` and the implementations they load —
 * through their normal HTTP entrypoint. Production routing has unrelated
 * application bindings, so this deliberately narrow entrypoint keeps calendar
 * tests hermetic while preserving the actual DO runtime and SQLite storage.
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

export { AiResponseCacheDurableObject } from "~/server/ai/response-cache-durable-object";
export {
  CalendarFeedDurableObject,
  ChatGptPlanDurableObject,
  DatabaseFreshnessDurableObject,
  PurchaseImportDurableObject,
  UsdaReleaseDurableObject,
} from "~/server/worker-entrypoints";
