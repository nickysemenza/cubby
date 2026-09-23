import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

it("allows the Worker to load server environment without a DATABASE_URL secret", async () => {
  vi.stubEnv("DATABASE_URL", "");
  vi.stubEnv("E2E_DATABASE_URL", "");
  vi.resetModules();

  const { env } = await import("./env");
  expect(env.DATABASE_URL).toBeUndefined();
});
