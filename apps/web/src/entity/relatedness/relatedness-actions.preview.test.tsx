import { testShortcode } from "@cubby/schemas/testing";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { z } from "zod";

import { overrideStartDispatch } from "~/integrations/tanstack-query/start-transport";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { ProductRelatednessActions, RelatednessRail } from "./relatedness-rail";

let harness: ReturnType<typeof createBrowserTestHarness> | undefined;
let restoreTransport: (() => void) | undefined;
afterEach(() => {
  restoreTransport?.();
  restoreTransport = undefined;
  harness?.dispose();
  harness = undefined;
});

// Failure modes: the header and rail can submit the same pending request;
// another Product can inherit its busy state; rejection can strand Retry.
it("shares indexing requests across controls while keeping other products and retry usable", async () => {
  harness = createBrowserTestHarness();
  const source = testShortcode("product", "PRD-SOURCE");
  const other = testShortcode("product", "PRD-OTHER");
  const requests: string[] = [];
  const first = Promise.withResolvers<void>();
  const second = Promise.withResolvers<void>();
  const completed = new Set<string>();
  restoreTransport = overrideStartDispatch(async (operation, input) => {
    const { entityId } = z.object({ entityId: z.string() }).parse(input);
    if (operation === "recommendations.forEntity") {
      return {
        ok: true,
        data: {
          source: { entityKind: "product", entityId },
          basisKey: "synthetic-index",
          groups: [
            {
              kind: "product-related",
              status: completed.has(entityId) ? "ready" : "uncomputed",
              proposals: [],
            },
          ],
        },
      };
    }
    if (operation !== "search.requestEmbeddingRefresh")
      throw new Error(`Unexpected operation ${operation}`);
    requests.push(entityId);
    if (requests.length === 1) await first.promise;
    if (entityId === source) await second.promise;
    completed.add(entityId);
    return { ok: true, data: { accepted: true } };
  });
  render(
    <>
      <section aria-label="Product header">
        <ProductRelatednessActions productId={source} />
      </section>
      <section aria-label="Product rail">
        <RelatednessRail product={{ id: source, tags: [] }} />
      </section>
      <section aria-label="Other product">
        <RelatednessRail product={{ id: other, tags: [] }} />
      </section>
    </>,
    { wrapper: harness.wrapper },
  );
  const header = within(screen.getByRole("region", { name: "Product header" }));
  const rail = within(screen.getByRole("region", { name: "Product rail" }));
  const otherRail = within(
    screen.getByRole("region", { name: "Other product" }),
  );
  const headerButton = await header.findByRole("button", { name: "Index now" });
  const railButton = await rail.findByRole("button", { name: "Index now" });
  const otherButton = await otherRail.findByRole("button", {
    name: "Index now",
  });
  // Both handlers can run before Query's batched observer notifications arrive.
  act(() => {
    headerButton.click();
    railButton.click();
  });
  await waitFor(() => {
    expect(headerButton).toBeDisabled();
    expect(railButton).toBeDisabled();
  });
  expect(otherButton).toBeEnabled();
  expect(requests).toEqual([source]);
  await userEvent.click(otherButton);
  await waitFor(() => expect(requests).toEqual([source, other]));
  first.reject(new Error("Synthetic index request failed: upstream 503"));
  await waitFor(() => {
    expect(headerButton).toBeEnabled();
    expect(railButton).toBeEnabled();
  });
  await userEvent.click(railButton);
  await waitFor(() => {
    expect(requests).toEqual([source, other, source]);
    expect(headerButton).toBeDisabled();
  });
  second.resolve();
  await waitFor(() => {
    expect(header.getByRole("button", { name: "Indexing…" })).toBeDisabled();
    expect(rail.getByRole("button", { name: "Indexing…" })).toBeDisabled();
  });
});
