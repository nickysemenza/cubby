import { productionWorker } from "../cloudflare.config.ts";

/** Canonical public media origin shared by Worker, browser, and native generation. */
export function readR2PublicUrl(): string {
  const parsed = new URL(productionWorker.env.R2_PUBLIC_URL.value);
  if (
    parsed.protocol !== "https:" ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  )
    throw new Error(
      "R2_PUBLIC_URL must be an HTTPS origin without a path, query, or hash",
    );
  return parsed.origin;
}
