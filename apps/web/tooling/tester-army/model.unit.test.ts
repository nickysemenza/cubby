import { FAST_MODEL } from "@cubby/shared/ai/models";
import { afterEach, expect, it, vi } from "vitest";

import { modelConfiguration, testerArmyGatewayHeaders } from "./model";

afterEach(() => vi.unstubAllEnvs());

// Failure modes: driver traffic lands on a separate or unnamed gateway, or a
// laptop run is reported as CI (or either as production); a per-run revision
// becomes a gateway label again.
it.each([
  { ci: "true", environment: "ci" },
  { ci: undefined, environment: "development" },
])("scopes the driver to cubby as $environment", ({ ci, environment }) => {
  const headers = testerArmyGatewayHeaders(ci);
  expect(headers["cf-aig-gateway-id"]).toBe("cubby");
  expect(headers["cf-aig-skip-cache"]).toBe("true");
  expect(JSON.parse(headers["cf-aig-metadata"])).toEqual({
    environment,
    feature: "tester-army",
    operation: "driver",
  });
});

// GitHub renders an unset repository variable as "", so a workflow that
// forwards one must still resolve the canonical driver and account.
it("treats blank workflow variables as omitted", () => {
  vi.stubEnv("TESTER_ARMY_CF_API_TOKEN", "synthetic-token");
  vi.stubEnv("TESTER_ARMY_MODEL", "");
  vi.stubEnv("TESTER_ARMY_CF_ACCOUNT_ID", "");
  const config = modelConfiguration();
  expect(config.TESTER_ARMY_MODEL).toBe(`openai/${FAST_MODEL}`);
  expect(config.TESTER_ARMY_CF_ACCOUNT_ID).toMatch(/^[a-f0-9]{32}$/u);
});
