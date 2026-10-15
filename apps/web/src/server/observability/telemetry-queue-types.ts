import type { TelemetryMessageV1 } from "@cubby/schemas/telemetry";

export interface TelemetryQueueProducer {
  send(body: TelemetryMessageV1): Promise<void>;
}

interface TelemetryQueueDeliveredMessage {
  readonly body: unknown;
  ack(): void;
  retry(): void;
}

export interface TelemetryQueueBatch {
  readonly queue: "cubby-telemetry";
  readonly messages: readonly TelemetryQueueDeliveredMessage[];
}
