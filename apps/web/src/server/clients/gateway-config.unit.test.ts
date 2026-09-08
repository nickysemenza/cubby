import { fromPartial } from "@total-typescript/shoehorn";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

it("uses the current Worker gateway without a local REST credential", async () => {
  vi.stubEnv("AI_GATEWAY_API_KEY", "");
  const { getAiGateway, setCfEnv } = await import("~/server/cf-env");
  const { gatewayAdapterConfig } = await import("./gateway-config");
  const first = fromPartial<NonNullable<ReturnType<typeof getAiGateway>>>({});
  const second = fromPartial<NonNullable<ReturnType<typeof getAiGateway>>>({});
  const metadata = { feature: "recipe-flow" };

  setCfEnv(fromPartial<Env>({ AI: { gateway: () => first } }));
  expect(gatewayAdapterConfig({ metadata })).toEqual({
    binding: first,
    metadata,
  });
  setCfEnv(fromPartial<Env>({ AI: { gateway: () => second } }));
  expect(gatewayAdapterConfig()).toEqual({ binding: second });
  setCfEnv(undefined);
});

it("reports missing local configuration instead of attempting an unauthenticated call", async () => {
  vi.stubEnv("AI_GATEWAY_API_KEY", "");
  const { gatewayAdapterConfig } = await import("./gateway-config");
  expect(() => gatewayAdapterConfig()).toThrow(
    "AI_GATEWAY_API_KEY is not configured",
  );
});
