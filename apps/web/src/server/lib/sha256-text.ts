import { createHash } from "node:crypto";

/** Exact UTF-8 SHA-256 for pure policy and retained source identities. */
export function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
