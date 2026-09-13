import type { BackgroundTaskMessageInput } from "@cubby/schemas/queue-messages";

export interface BackgroundQueueProducer {
  sendBatch(
    messages: Iterable<{ body: BackgroundTaskMessageInput }>,
  ): Promise<void>;
}

export interface BackgroundQueueDeliveredMessage {
  /**
   * `unknown`, not the message type: what Cloudflare hands back is whatever
   * JSON was on the wire, including messages minted by an older deploy. Typing
   * it forces the consumer through `safeParse`.
   */
  readonly body: unknown;
  ack(): void;
  retry(options?: { delaySeconds: number }): void;
}

export interface BackgroundQueueBatch {
  readonly queue: "cubby-background";
  readonly messages: readonly BackgroundQueueDeliveredMessage[];
}
