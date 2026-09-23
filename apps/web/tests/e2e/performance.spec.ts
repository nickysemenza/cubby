import { expect, test } from "./e2e-test";
import { gotoAuthenticatedPage } from "./e2e-helpers";

test("intent-preloaded navigation does not flash the route skeleton", async ({
  page,
}) => {
  await gotoAuthenticatedPage(page, "/");
  if (process.env.CUBBY_E2E_HTTP2 === "1") {
    const assetProtocols = await page.evaluate(() =>
      performance
        .getEntriesByType("resource")
        .filter((entry) => entry.name.includes("/assets/"))
        .map((entry) => {
          // SAFETY: Resource performance entries are PerformanceResourceTiming.
          return (entry as PerformanceResourceTiming).nextHopProtocol;
        }),
    );
    expect(assetProtocols.length).toBeGreaterThan(0);
    expect(assetProtocols).toContain("h2");
    const socketResponse = await page.request.get("/api/import/agent/socket", {
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
      },
    });
    expect(socketResponse.status()).toBe(400);
    expect(await socketResponse.text()).toContain("vendorAccount is required");
  }
  const locations = page
    .getByRole("region", { name: "Pantry", exact: true })
    .getByRole("link", { name: /^Locations(?: [\d,]+ records)?$/ });
  await locations.hover();
  await page.waitForTimeout(75);
  await locations.click();
  await expect(page.locator('main [data-slot="skeleton"]')).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Locations" })).toBeVisible();
});
