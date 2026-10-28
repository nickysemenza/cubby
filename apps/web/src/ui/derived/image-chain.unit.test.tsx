import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { fieldExplanation } from "~/integrations/tanstack-query/domains/fieldExplanation";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { RecordImageChain } from "./image-chain";

let harness: ReturnType<typeof createBrowserTestHarness> | undefined;
afterEach(() => {
  cleanup();
  harness?.dispose();
});

it("loads the dedicated image chain and preserves precedence, cover, and source links", async () => {
  harness = createBrowserTestHarness();
  let requestedInput: unknown;
  const explain = fieldExplanation.imageChain.withTransport(async (request) => {
    requestedInput = request.input;
    return {
      levels: [
        {
          label: "Own",
          source: null,
          images: [
            { id: "own-image", url: "/synthetic-own.svg", chosen: true },
          ],
        },
        {
          label: "From product PRD-4K7M",
          source: { entityKind: "product", entityId: "PRD-4K7M" },
          images: [
            { id: "source-image", url: "/synthetic-source.svg", chosen: false },
          ],
        },
      ],
    };
  });
  render(
    <RecordImageChain
      entity="inventory"
      id="INV-4K7M"
      explain={explain.queryOptions}
    />,
    { wrapper: harness.wrapper },
  );
  const chain = await screen.findByLabelText("Display image chain");
  expect(requestedInput).toEqual({
    entityKind: "inventory",
    entityId: "INV-4K7M",
  });
  const levels = within(chain).getAllByRole("listitem");
  expect(levels).toHaveLength(2);
  expect(levels[0]).toHaveTextContent("Own");
  expect(levels[1]).toHaveTextContent("From product PRD-4K7M");
  expect(within(chain).getAllByText("Cover")).toHaveLength(1);
  expect(
    within(chain).getByRole("img", { name: "Chosen cover" }),
  ).toBeVisible();
  expect(
    within(chain).getByRole("link", { name: "From product PRD-4K7M" }),
  ).toHaveAttribute("href", "/products/PRD-4K7M");
});
