import { expect, it } from "vitest";

import { testerArmyGatewayHeaders } from "./model";

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
