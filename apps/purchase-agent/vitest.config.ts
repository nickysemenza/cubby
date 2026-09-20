import { defineConfig } from "vitest/config";

// Unit tests exercise the queue and authority contracts without booting a
// Cloudflare runtime; Worker integration belongs to the two-Worker harness.
export default defineConfig({
  test: { environment: "node" },
});
