import type { FieldExplanationVerification } from "@cubby/schemas/field-explanation";
import { render, screen } from "@testing-library/react";
import { fromPartial } from "@total-typescript/shoehorn";
import { afterEach, beforeEach, expect, it } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { FieldVerificationEvidence } from "./field-explanation";

let harness: ReturnType<typeof createBrowserTestHarness>;
beforeEach(() => {
  harness = createBrowserTestHarness();
});
afterEach(() => {
  harness.dispose();
});

// A collection's proof must identify its own live operand, rather than merely repeat the rationale.
it("shows each verified collection member with public references and keeps byte identity in technical details", () => {
  const verification = (
    key: string,
    fieldPath: string,
    value: FieldExplanationVerification["value"],
  ) =>
    fromPartial<FieldExplanationVerification>({
      key,
      fieldPath,
      value,
      run: { entityKind: "run", entityId: "RUN-4K7M" },
      subject: { entityKind: "product", entityId: "PRD-4K7M" },
      verifiedAt: "2026-10-07T16:00:00.000Z",
      supportRetiredAt: null,
      support: {
        observation: "The selected blue variant lists SKU BLUE-42.",
        reasoning: "The retained selection matches the ordered blue variant.",
      },
      source: {
        label: "Fixture maker",
        url: "https://maker.example.test/blue",
        kind: "web_page",
      },
    });
  render(
    <FieldVerificationEvidence
      verifications={[
        verification("sku", "externalIds.i11111111111111111111111111111111", {
          kind: "sku",
          externalId: "BLUE-42",
          source: "fixture-maker",
        }),
        verification("image", "images.i22222222222222222222222222222222", {
          imageId: "IMG-4K7M",
          sourceAssetUrl: "https://maker.example.test/blue.jpg",
          contentHash: "a".repeat(64),
        }),
      ]}
    />,
    { wrapper: harness.wrapper },
  );
  expect(screen.getByText("BLUE-42")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "IMG-4K7M" })).toHaveAttribute(
    "href",
    expect.stringContaining("IMG-4K7M"),
  );
  expect(
    screen.getByRole("link", { name: "https://maker.example.test/blue.jpg" }),
  ).toHaveAttribute("href", "https://maker.example.test/blue.jpg");
  expect(screen.queryByText("a".repeat(64))).not.toBeInTheDocument();
  expect(screen.getAllByRole("link", { name: "RUN-4K7M" })).toHaveLength(2);
});

it("keeps the accepted value and source visible when verification rationale is retired", () => {
  render(
    <FieldVerificationEvidence
      verifications={[
        fromPartial<FieldExplanationVerification>({
          key: "retired-model",
          fieldPath: "model",
          value: "Q-17",
          run: { entityKind: "run", entityId: "RUN-4K7M" },
          subject: { entityKind: "product", entityId: "PRD-4K7M" },
          verifiedAt: "2026-10-07T16:00:00.000Z",
          support: null,
          supportRetiredAt: "2026-10-07T17:00:00.000Z",
          source: {
            label: "Retained maker specifications",
            url: "https://maker.example.test/q17",
            kind: "web_page",
          },
        }),
      ]}
    />,
    { wrapper: harness.wrapper },
  );
  expect(screen.getByText("Q-17")).toBeVisible();
  expect(
    screen.getByRole("link", { name: "Retained maker specifications" }),
  ).toHaveAttribute("href", "https://maker.example.test/q17");
  expect(screen.getByText("Verification rationale retired")).toBeVisible();
  expect(screen.getByText(/Proof gap/)).toBeVisible();
  expect(
    screen.queryByText("Verified against sources"),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "RUN-4K7M" })).toHaveAttribute(
    "href",
    expect.stringContaining("RUN-4K7M"),
  );
  expect(screen.getByText(/Retired/).closest("time")).toHaveAttribute(
    "dateTime",
    "2026-10-07T17:00:00.000Z",
  );
});
