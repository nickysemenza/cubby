import type { BackgroundQueueMessage } from "@cubby/schemas/queue-messages";

export interface BackgroundQueueProducer {
  send(body: BackgroundQueueMessage): Promise<void>;
  sendBatch(
    messages: Iterable<{ body: BackgroundQueueMessage }>,
  ): Promise<void>;
}

export interface BackgroundQueueDeliveredMessage {
  /**
   * `unknown`, not `BackgroundQueueMessage`: what Cloudflare hands back is
   * whatever JSON was on the wire, including messages minted by an older
   * deploy. Typing it forces the consumer through `safeParse`.
   */
  readonly body: unknown;
  ack(): void;
  retry(options?: { delaySeconds: number }): void;
}

export interface BackgroundQueueBatch {
  readonly queue: "cubby-background";
  readonly messages: readonly BackgroundQueueDeliveredMessage[];
}
