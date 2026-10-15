import type {
  ImageDerivativeStatus,
  ImageProcessingJobState,
} from "@cubby/schemas/image-processing";

const STATE_LABEL = {
  ready: "Completed",
  skipped: "Skipped",
  pending: "Queued",
  leased: "Processing",
  waiting_for_device: "Waiting for Apple",
  failed: "Failed",
  abandoned: "Abandoned",
} as const satisfies Record<
  ImageProcessingJobState | ImageDerivativeStatus,
  string
>;

/** An image processing or cutout state as the Image page words it. */
export const workStateLabel = (
  state: ImageProcessingJobState | ImageDerivativeStatus,
) => STATE_LABEL[state];
