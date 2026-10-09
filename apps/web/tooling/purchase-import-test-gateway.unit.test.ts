import { expect, it } from "vitest";

import gateway, {
  type Fixture,
} from "../tests/e2e/harness-services/purchase-import-test-gateway";

it("enables exact public source transport only for an explicitly configured scripted fixture", async () => {
  const configure = async (sources?: Fixture["sources"]) => {
    const configuration: Partial<Fixture> = { extractions: [] };
    if (sources !== undefined) configuration.sources = sources;
    return gateway.fetch(
      new Request("https://gateway.test/configure", {
        method: "POST",
        body: JSON.stringify(configuration),
      }),
    );
  };
  const fetch = (pathname: string, body?: Record<string, string>) =>
    gateway.fetch(
      new Request(
        `https://gateway.test${pathname}`,
        body ? { method: "POST", body: JSON.stringify(body) } : undefined,
      ),
    );
  await configure();
  expect(await (await fetch("/research-fixture-config")).json()).toEqual({
    enabled: false,
  });
  const page = {
    url: "https://maker.example.test/small-blue",
    title: "Small blue fan",
    description: "Product specification page",
    html: "<h1>Small blue fan</h1><p>Selected variant: small, blue</p>",
  };
  await configure([page]);
  expect(await (await fetch("/research-fixture-config")).json()).toEqual({
    enabled: true,
  });
  expect(
    await (await fetch("/research-search", { query: "small blue fan" })).json(),
  ).toEqual({
    items: [
      { url: page.url, title: page.title, description: page.description },
    ],
  });
  expect(
    await (await fetch("/research-page", { url: page.url })).json(),
  ).toEqual({
    status: "fetched",
    url: page.url,
    html: page.html,
    durationMs: 1,
  });
  expect(
    await (
      await fetch("/research-page", {
        url: "https://maker.example.test/unknown",
      })
    ).json(),
  ).toMatchObject({ status: "blocked" });
  await configure();
  expect(await (await fetch("/research-fixture-config")).json()).toEqual({
    enabled: false,
  });
});
