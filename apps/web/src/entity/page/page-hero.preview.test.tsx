import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { page } from "vitest/browser";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";
import { Button } from "~/ui/primitives/button";

import { PageHeader } from "./page-hero";

let harness: ReturnType<typeof createBrowserTestHarness>;
beforeEach(() => {
  harness = createBrowserTestHarness();
});
afterEach(() => {
  harness.dispose();
});

for (const width of [402, 900, 1280]) {
  it(`keeps detail identity and facts compact without clipping at ${width}px`, async () => {
    await page.viewport(width, 874);
    render(
      <PageHeader
        variant="detail"
        entity="product"
        title="Example utility lamp"
        heroNo="4K7M"
        heroStamp={{ label: "Ready" }}
        rawData={{ createdAt: "2026-01-01T12:00:00Z" }}
        heroActions={{ primary: <Button size="sm">Edit</Button> }}
        heroStats={[
          { label: "Value", value: "$48.00" },
          { label: "On hand", value: "3" },
        ]}
      />,
      { wrapper: harness.wrapper },
    );
    const title = screen.getByRole("heading").getBoundingClientRect();
    const edit = screen
      .getByRole("button", { name: "Edit" })
      .getBoundingClientRect();
    const plate = screen
      .getByTestId("detail-spec-plate")
      .getBoundingClientRect();
    const centersMatch =
      Math.abs(title.top + title.height / 2 - edit.top - edit.height / 2) <= 2;
    expect(centersMatch).toBe(width >= 640);
    expect(plate.height).toBeLessThanOrEqual(width < 640 ? 164 : 120);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    expect(screen.getByText("$48.00")).toBeVisible();
  });
}
