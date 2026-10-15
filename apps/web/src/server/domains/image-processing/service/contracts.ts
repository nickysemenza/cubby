import type { ImageProcessingCommand } from "@cubby/schemas/image-processing";

/** One device attempt's lease, whether a wakeup or the device's socket claimed it. */
export const COMPANION_LEASE_MS = 5 * 60_000;

/** Shared transport, deliberately separate from vendor-authenticated browser commands. */
export interface ImageProcessingCompanionRpc {
  dispatch(command: ImageProcessingCommand): Promise<boolean>;
}
