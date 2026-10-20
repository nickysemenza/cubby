import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { ReadableExplanationValue } from "./field-explanation";

let harness: ReturnType<typeof createBrowserTestHarness>;
beforeEach(() => {
  harness = createBrowserTestHarness();
});
afterEach(() => {
  harness.dispose();
});

it("keeps shortcode-shaped retailer identifiers literal while linking source records", () => {
  render(
    <ReadableExplanationValue
      value={[
        {
          source: { id: "VEN-4K7M", name: "Synthetic evidence supplier" },
          kind: "retailer_sku",
          externalId: "RUN-4K7M",
        },
      ]}
    />,
    { wrapper: harness.wrapper },
  );
  expect(screen.getByText("RUN-4K7M")).toBeVisible();
  expect(
    screen.queryByRole("link", { name: "RUN-4K7M" }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("link", { name: "Synthetic evidence supplier" }),
  ).toHaveAttribute("href", "/vendors/VEN-4K7M");
});
