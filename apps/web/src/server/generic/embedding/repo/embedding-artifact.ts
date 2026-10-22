import { sha256Hex } from "@cubby/shared/sha256";

/** Vectorize persists float32 values; compare the physical payload after visibility. */
export const vectorPayloadHash = (values: readonly number[]) =>
  sha256Hex(JSON.stringify(values.map(Math.fround)));
