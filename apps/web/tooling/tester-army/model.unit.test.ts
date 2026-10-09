import { FAST_MODEL, QUALITY_MODEL } from "@cubby/shared/ai/models";
import { afterEach, expect, it, vi } from "vitest";

import {
  modelConfiguration,
  testerArmyGatewayHeaders,
  testerArmyModel,
} from "./model";

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
  vi.stubEnv("TESTER_ARMY_PROVIDER", "");
  vi.stubEnv("TESTER_ARMY_MODEL", "");
  vi.stubEnv("TESTER_ARMY_CF_ACCOUNT_ID", "");
  const config = modelConfiguration(process.env, () => undefined);
  expect(config.TESTER_ARMY_PROVIDER).toBe("chatgpt");
  expect(config.TESTER_ARMY_MODEL).toBe(`chatgpt/${QUALITY_MODEL}`);
  expect(config.TESTER_ARMY_CF_ACCOUNT_ID).toMatch(/^[a-f0-9]{32}$/u);
});

// The ChatGPT subscription needs no gateway token (covered above); the
// Cloudflare gateway stays an explicit opt-in that refuses to start without one.
it("requires a token and an OpenAI model id for the gateway provider", () => {
  vi.stubEnv("TESTER_ARMY_PROVIDER", "gateway");
  expect(
    modelConfiguration(process.env, () => "synthetic-token").TESTER_ARMY_MODEL,
  ).toBe(`openai/${FAST_MODEL}`);
  expect(() => modelConfiguration(process.env, () => undefined)).toThrow(
    /TESTER_ARMY_CF_API_TOKEN/u,
  );
});

// Cloudflare's unified endpoint names models `author/model`; only the
// ChatGPT subscription takes the bare id.
it("sends the gateway the provider-prefixed model and ChatGPT the bare id", () => {
  vi.stubEnv("TESTER_ARMY_PROVIDER", "gateway");
  expect(
    testerArmyModel(modelConfiguration(process.env, () => "synthetic-token"))
      .modelId,
  ).toBe(`openai/${FAST_MODEL}`);
  vi.stubEnv("TESTER_ARMY_PROVIDER", "chatgpt");
  expect(
    testerArmyModel(modelConfiguration(process.env, () => undefined)).modelId,
  ).toBe(QUALITY_MODEL);
});
