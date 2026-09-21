import type { ImageProcessingCommand } from "@cubby/schemas/image-processing";

/** Shared transport, deliberately separate from vendor-authenticated browser commands. */
export interface ImageProcessingCompanionRpc {
  dispatch(command: ImageProcessingCommand): Promise<boolean>;
}
