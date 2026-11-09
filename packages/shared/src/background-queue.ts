import consumer from "./background-queue-consumer.json" with { type: "json" };

/**
 * The `cubby-background` queue consumer as deployed: `cloudflare.config.ts`
 * reads the same JSON as bytes. Each message is one permit to run one unit,
 * so `maxConcurrency` is how many units run at once and the only background
 * concurrency bound (docs/infrastructure.md#background-connection-budget).
 */
export const BACKGROUND_QUEUE_CONSUMER = consumer;
