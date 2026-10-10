import type { FieldExplanationVerification } from "@cubby/schemas/field-explanation";
import { runShortcode } from "@cubby/schemas/identifiers";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import {
  FieldVerificationEvidence,
  ReadableExplanationValue,
} from "./field-explanation";

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

// An overwritten value's Source stays visible as history rather than vanishing or reading as current.
it("shows each field Source with whether it still supports the current value", () => {
  const source = (
    key: string,
    supportsCurrentValue: boolean,
    quote: string,
  ): FieldExplanationVerification => ({
    key,
    fieldPath: "model",
    url: `https://maker.example.test/${key}`,
    quote,
    selectedVariant: key === "current" ? "Blue, 42" : null,
    supportsCurrentValue,
    recorder: {
      channel: "mcp",
      oauthClientId: null,
      runId: key === "current" ? runShortcode.parse("RUN-4K7M") : null,
      deviceId: null,
    },
    observedAt: null,
    createdAt: "2026-10-07T16:00:00.000Z",
  });
  render(
    <FieldVerificationEvidence
      verifications={[
        source("current", true, "Model Q-17 in blue."),
        source("earlier", false, "Model Q-16."),
      ]}
    />,
    { wrapper: harness.wrapper },
  );
  expect(screen.getByText("Current value")).toBeVisible();
  expect(screen.getByText("Earlier value")).toBeVisible();
  expect(screen.getByText(/Model Q-16\./u)).toBeVisible();
  expect(screen.getByText("Selected variant: Blue, 42")).toBeVisible();
  expect(
    screen.getByRole("link", { name: "https://maker.example.test/earlier" }),
  ).toHaveAttribute("href", "https://maker.example.test/earlier");
  expect(screen.getByRole("link", { name: "RUN-4K7M" })).toHaveAttribute(
    "href",
    expect.stringContaining("RUN-4K7M"),
  );
});
