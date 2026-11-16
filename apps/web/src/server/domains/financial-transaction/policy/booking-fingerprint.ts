import { createHash } from "node:crypto";

/** Preserve persisted JSON fingerprint bytes without a separate encoding buffer. */
export const digestValue = <T extends object>(value: T) => {
  const serialized = JSON.stringify(value);
  return createHash("sha256")
    .update(serialized ?? "")
    .digest("hex");
};
