import consumer from "./background-queue-consumer.json" with { type: "json" };

/**
 * The `cubby-background` queue consumer as deployed: `cloudflare.config.ts`
 * reads the same JSON as bytes, so the Run page's limits show what the queue
 * actually runs. A wake only drains durable Jobs, so `maxConcurrency` is how
 * many drains run at once.
 */
export const BACKGROUND_QUEUE_CONSUMER = consumer;
