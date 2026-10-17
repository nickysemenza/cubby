import {
  bindings,
  defineConfig,
  defineWorker,
  exports,
  triggers,
} from "cf/config";
import { fileURLToPath } from "node:url";
import { resolveDevProfile } from "../../scripts/lib/dev-profile.ts";
import { localWorker } from "./tooling/dev/config.ts";

// Existing names and lifecycle tombstones preserve stored Durable Object namespaces.
export const productionWorker = defineWorker({
  name: "cubby",
  compatibilityDate: "2026-09-19",
  compatibilityFlags: ["nodejs_compat", "enable_request_signal"],
  entrypoint: "src/cf-server.ts",
  // The custom domain is the only production origin.
  workersDev: false,
  previewUrls: false,
  // Sequential Hyperdrive reads run near the database; Smart Placement regressed them.
  placement: {
    region: "aws:us-west-2",
  },
  limits: {
    cpuMs: 45000,
  },
  observability: {
    enabled: true,
    headSamplingRate: 1,
    redactQueryString: false,
    logs: {
      enabled: true,
      headSamplingRate: 1,
      persist: true,
      invocationLogs: true,
      destinations: ["grafana-logs"],
    },
    traces: {
      enabled: true,
      persist: true,
      headSamplingRate: 1,
    },
    issues: {
      enabled: true,
    },
  },
  assets: {
    htmlHandling: "none",
  },
  domains: ["cubby.nickysemenza.com"],
  // No dead-letter queues: freshness gates retain unfinished work for retry.
  triggers: [
    triggers.scheduled({
      schedule: "0 12 * * *",
    }),
    // Bound image and background database concurrency independently.
    triggers.queue({
      maxBatchSize: 1,
      maxBatchTimeout: 0,
      maxConcurrency: 4,
      maxRetries: 3,
      name: "cubby-image-cloud",
    }),
    triggers.queue({
      maxBatchSize: 1,
      maxBatchTimeout: 0,
      maxConcurrency: 2,
      maxRetries: 3,
      name: "cubby-background",
    }),
    triggers.queue({
      maxBatchSize: 100,
      maxBatchTimeout: 5,
      maxConcurrency: 1,
      maxRetries: 3,
      name: "cubby-telemetry",
    }),
    triggers.queue({
      maxBatchSize: 10,
      maxBatchTimeout: 5,
      maxRetries: 3,
      name: "cubby-purchase-agent",
    }),
  ],
  env: {
    BETTER_AUTH_SECRET: bindings.secret(),
    R2_ACCESS_KEY_ID: bindings.secret(),
    R2_SECRET_ACCESS_KEY: bindings.secret(),
    AI_REFRESH_ENABLED: bindings.text("true"),
    NODE_ENV: bindings.text("production"),
    ALLOW_SIGNUP: bindings.text("false"),
    E2E_AUTH_TEST_MODE: bindings.text("false"),
    APP_ORIGIN: bindings.text("https://cubby.nickysemenza.com"),
    R2_ENDPOINT: bindings.text(
      "https://9f10f078d35d86c78dedece2300a6b88.r2.cloudflarestorage.com",
    ),
    R2_BUCKET_NAME: bindings.text("foo"),
    R2_PUBLIC_URL: bindings.text("https://media.nickysemenza.com"),
    R2_KEY_PREFIX: bindings.text("cubby"),
    GOOGLE_CLIENT_ID: bindings.text(
      "183601884678-9rddrge4anct24rnbvqb5jm5q9fb8oqg.apps.googleusercontent.com",
    ),
    USDA_ACTIVE_RELEASE: bindings.text("2026-04"),
    HYPERDRIVE: bindings.hyperdrive({
      id: "adc9757dfffd45bc94d5c2a66b2ad410",
    }),
    HYPERDRIVE_CACHED: bindings.hyperdrive({
      id: "427dd7a2876c4dccbe056d37fa7374ff",
    }),
    USDA_RELEASES: bindings.r2({
      name: "cubby-usda-releases",
    }),
    VECTORIZE: bindings.vectorize({
      name: "cubby-openai-text-embedding-3-small-1536",
    }),
    BACKGROUND_QUEUE: bindings.queue({
      name: "cubby-background",
    }),
    IMAGE_CLOUD_QUEUE: bindings.queue({
      name: "cubby-image-cloud",
    }),
    TELEMETRY_QUEUE: bindings.queue({
      name: "cubby-telemetry",
    }),
    PURCHASE_AGENT_QUEUE: bindings.queue({
      name: "cubby-purchase-agent",
    }),
    AI_GATEWAY_EGRESS: bindings.durableObject({
      worker: "cubby",
      exportName: "AiGatewayEgressDurableObject",
    }),
    DB_FRESHNESS: bindings.durableObject({
      worker: "cubby",
      exportName: "DatabaseFreshnessDurableObject",
    }),
    CALENDAR_FEED: bindings.durableObject({
      worker: "cubby",
      exportName: "CalendarFeedDurableObject",
    }),
    IMAGE_PROCESSING: bindings.durableObject({
      worker: "cubby",
      exportName: "ImageProcessingDurableObject",
    }),
    AI_RESPONSE_CACHE: bindings.durableObject({
      worker: "cubby",
      exportName: "AiResponseCacheDurableObject",
    }),
    CHATGPT_PLAN: bindings.durableObject({
      worker: "cubby",
      exportName: "ChatGptPlanDurableObject",
    }),
    PURCHASE_IMPORT_RUN: bindings.durableObject({
      worker: "cubby",
      exportName: "PurchaseImportRunAgent",
    }),
    USDA_RELEASE: bindings.durableObject({
      worker: "cubby",
      exportName: "UsdaReleaseDurableObject",
    }),
    AI_REFRESH: bindings.workflow({
      name: "cubby-ai-refresh",
      worker: "cubby",
      exportName: "AiRefreshWorkflow",
    }),
    SEARCH_INDEX_REPAIR: bindings.workflow({
      name: "cubby-search-index-repair",
      worker: "cubby",
      exportName: "SearchIndexRepairWorkflow",
    }),
    MAIL_DISCOVERY: bindings.workflow({
      name: "cubby-mail-discovery",
      worker: "cubby",
      exportName: "MailDiscoveryWorkflow",
    }),
    AI: bindings.ai({}),
    CF_VERSION_METADATA: bindings.versionMetadata(),
  },
  exports: {
    AiGatewayEgressDurableObject: exports.durableObject({
      storage: "sqlite",
    }),
    UsdaReleaseDurableObject: exports.durableObject({
      storage: "sqlite",
    }),
    DatabaseFreshnessDurableObject: exports.durableObject({
      storage: "sqlite",
    }),
    CalendarFeedDurableObject: exports.durableObject({
      storage: "sqlite",
    }),
    PurchaseImportDurableObject: exports.durableObject({
      state: "deleted",
    }),
    ImageProcessingDurableObject: exports.durableObject({
      storage: "sqlite",
    }),
    AiResponseCacheDurableObject: exports.durableObject({
      storage: "sqlite",
    }),
    ChatGptPlanDurableObject: exports.durableObject({
      storage: "sqlite",
    }),
    PurchaseImportRunAgent: exports.durableObject({
      storage: "sqlite",
    }),
    AiRefreshWorkflow: exports.workflow({
      name: "cubby-ai-refresh",
    }),
    SearchIndexRepairWorkflow: exports.workflow({
      name: "cubby-search-index-repair",
    }),
    MailDiscoveryWorkflow: exports.workflow({
      name: "cubby-mail-discovery",
    }),
  },
});

export default defineConfig(({ mode }) => ({
  worker:
    mode === "development" || process.env.CUBBY_DEV_PREVIEW_BUILD === "true"
      ? localWorker(
          productionWorker,
          resolveDevProfile(fileURLToPath(new URL("../..", import.meta.url))),
        )
      : productionWorker,
}));
