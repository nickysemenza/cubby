import type { BackgroundJobKind } from "@cubby/schemas/background-jobs";

export const BACKGROUND_MESSAGE_VERSION = 1;

interface BackgroundQueueMessage {
  messageVersion: number;
  batchId: string;
  jobId: string;
  kind: BackgroundJobKind;
}

export interface BackgroundQueueProducer {
  send(body: BackgroundQueueMessage): Promise<void>;
  sendBatch(
    messages: Iterable<{ body: BackgroundQueueMessage }>,
  ): Promise<void>;
}

export interface BackgroundQueueDeliveredMessage {
  readonly body: BackgroundQueueMessage;
  ack(): void;
  retry(): void;
}

export interface BackgroundQueueBatch {
  readonly queue: "cubby-background";
  readonly messages: readonly BackgroundQueueDeliveredMessage[];
}
