import * as Sentry from "@sentry/cloudflare";

import { workerSentryOptions } from "~/server/observability/worker-sentry";
import { handleHttpRequest } from "~/server/worker/http";
import { handleQueueInvocation } from "~/server/worker/queue";
import { handleScheduledInvocation } from "~/server/worker/scheduled";

// These named exports are persistent Cloudflare resource identities.
export { AiResponseCacheDurableObject } from "./server/ai/response-cache-durable-object";
export { ChatGptPlanDurableObject } from "./server/ai/chatgpt/durable-object";
export { CalendarFeedDurableObject } from "./server/domains/calendar/operations/durable-object";
export { DatabaseFreshnessDurableObject } from "./server/db/freshness/database-freshness-durable-object";
export { ImageProcessingDurableObject } from "./server/domains/image-processing/operations/durable-object";
export { PurchaseImportRunAgent } from "./server/domains/purchase-import/operations/agent-host";
export { UsdaReleaseDurableObject } from "./server/domains/usda-release/operations/durable-object";

export default Sentry.withSentry(workerSentryOptions, {
  fetch: handleHttpRequest,
  queue: handleQueueInvocation,
  scheduled: handleScheduledInvocation,
});

export { AiGatewayEgressDurableObject } from "./server/domains/run/operations/gateway-egress-durable-object";
