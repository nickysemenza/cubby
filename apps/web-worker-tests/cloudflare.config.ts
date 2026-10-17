import { bindings, defineConfig, defineWorker } from "cf/config";

export const testWorker = defineWorker({
  name: "cubby-calendar-test",
  entrypoint: "../web/tooling/calendar-test-worker.ts",
  compatibilityDate: "2026-09-19",
  compatibilityFlags: ["nodejs_compat"],
  env: {
    AI_GATEWAY_EGRESS: bindings.durableObject({
      worker: "cubby-calendar-test",
      exportName: "AiGatewayEgressDurableObject",
    }),
    DB_FRESHNESS: bindings.durableObject({
      worker: "cubby-calendar-test",
      exportName: "DatabaseFreshnessDurableObject",
    }),
    CALENDAR_FEED: bindings.durableObject({
      worker: "cubby-calendar-test",
      exportName: "CalendarFeedDurableObject",
    }),
    AI_RESPONSE_CACHE: bindings.durableObject({
      worker: "cubby-calendar-test",
      exportName: "AiResponseCacheDurableObject",
    }),
    CHATGPT_PLAN: bindings.durableObject({
      worker: "cubby-calendar-test",
      exportName: "ChatGptPlanDurableObject",
    }),
    USDA_RELEASE: bindings.durableObject({
      worker: "cubby-calendar-test",
      exportName: "UsdaReleaseDurableObject",
    }),
    USDA_RELEASES: bindings.r2({ name: "cubby-usda-releases-test" }),
    PURCHASE_AGENT_QUEUE: bindings.queue({ name: "cubby-purchase-agent-test" }),
  },
  exports: {
    AiGatewayEgressDurableObject: { type: "durable-object", storage: "sqlite" },
    DatabaseFreshnessDurableObject: {
      type: "durable-object",
      storage: "sqlite",
    },
    CalendarFeedDurableObject: { type: "durable-object", storage: "sqlite" },
    AiResponseCacheDurableObject: { type: "durable-object", storage: "sqlite" },
    ChatGptPlanDurableObject: { type: "durable-object", storage: "sqlite" },
    UsdaReleaseDurableObject: { type: "durable-object", storage: "sqlite" },
  },
});

export default defineConfig({ worker: testWorker });
