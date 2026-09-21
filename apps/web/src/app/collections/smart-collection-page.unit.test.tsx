import type { SmartCollectionDetailOut } from "@cubby/schemas/collection";
import { testShortcode } from "@cubby/schemas/testing";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { collection } from "./collection.functions";
import { SmartCollectionPage } from "./smart-collection-page";
import { SmartCollectionProvider } from "./smart-collection-state";

const PRODUCT_ID = testShortcode("product", "PRD-SMRT");
const LOCATION_ID = testShortcode("location", "LOC-SMRT");

let harness: ReturnType<typeof createBrowserTestHarness>;
let requests: unknown[];

beforeEach(() => {
  harness = createBrowserTestHarness();
  requests = [];
});

afterEach(() => {
  cleanup();
  harness.dispose();
});

function operations() {
  return {
    smartDetail: collection.smartDetail.withTransport(async ({ input }) => {
      requests.push(input);
      const result: SmartCollectionDetailOut = {
        summary: {
          key: input.definition.key,
          name: input.definition.name,
          totalCount: 1,
          sourceCounts: {
            productTagEquals: 0,
            manufacturerEquals: 0,
            effectiveOwnerEquals: 0,
            categoryEquals: 0,
            categoryFeatureEquals: 0,
            locationNameContains: 1,
            historicalExpenseTrade: 1,
          },
        },
        products: [
          {
            id: PRODUCT_ID,
            name: "Sample paint roller",
            manufacturer: "Example Co.",
            imageUrl: null,
            direct: false,
            inherited: false,
            matches: [
              {
                ruleIndex: 1,
                kind: "locationNameContains",
                value: "paint",
                evidence: ["Workshop / Paint cabinet"],
              },
              {
                ruleIndex: 0,
                kind: "historicalExpenseTrade",
                value: "finishes",
                evidence: ["Paint & Finishes expense"],
              },
            ],
            placements: [
              {
                id: LOCATION_ID,
                name: "Paint cabinet",
                path: ["Workshop", "Paint cabinet"],
              },
            ],
            purchases: [],
          },
        ],
        totalCount: 1,
      };
      return result;
    }),
  };
}

function renderPage(onSearchChange = vi.fn()) {
  return render(
    <SmartCollectionProvider>
      <SmartCollectionPage
        starterKey="painting"
        page={1}
        onSearchChange={onSearchChange}
        operations={operations()}
      />
    </SmartCollectionProvider>,
    { wrapper: harness.wrapper },
  );
}

describe("SmartCollectionPage", () => {
  it("shows overlapping source counts and every membership explanation", async () => {
    renderPage();

    expect(await screen.findByText("Sample paint roller")).toBeVisible();
    expect(screen.getAllByText("Dynamic")).toHaveLength(2);
    expect(screen.getByText("Workshop / Paint cabinet")).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "Why included: 2 matches" }),
    );
    expect(await screen.findByText("Paint & Finishes expense")).toBeVisible();
    expect(screen.getByText(/Source counts overlap/)).toBeVisible();
    expect(screen.getByText("Distinct products")).toBeVisible();
  }, 15_000);

  it("debounces valid temporary edits and resets them to the starter", async () => {
    const onSearchChange = vi.fn();
    renderPage(onSearchChange);
    await screen.findByText("Sample paint roller");

    fireEvent.click(
      screen.getByRole("button", { name: /Edit temporary rules/ }),
    );
    const locationValue = screen.getByRole("textbox", {
      name: "Condition 2 value",
    });
    fireEvent.change(locationValue, { target: { value: "studio" } });

    expect(screen.getByText("Temporary changes")).toBeVisible();
    await waitFor(
      () =>
        expect(requests).toContainEqual(
          expect.objectContaining({
            definition: expect.objectContaining({
              rules: expect.arrayContaining([
                { kind: "locationNameContains", value: "studio" },
              ]),
            }),
          }),
        ),
      { timeout: 1_000 },
    );
    expect(onSearchChange).toHaveBeenCalledWith({ page: 1 });

    fireEvent.click(screen.getByRole("button", { name: "Reset to starter" }));
    expect(screen.queryByText("Temporary changes")).toBeNull();
    expect(
      screen.getByRole("textbox", { name: "Condition 2 value" }),
    ).toHaveValue("paint");

    const firstCondition = screen.getByRole("combobox", {
      name: "Condition 1 type",
    });
    const secondCondition = screen.getByRole("combobox", {
      name: "Condition 2 type",
    });
    fireEvent.change(secondCondition, {
      target: { value: "manufacturerEquals" },
    });
    expect(screen.getByRole("combobox", { name: "Condition 2 type" })).toBe(
      secondCondition,
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "Condition 2 value" }),
      { target: { value: "Example Co." } },
    );
    await waitFor(
      () =>
        expect(requests.at(-1)).toEqual(
          expect.objectContaining({
            definition: expect.objectContaining({
              rules: expect.arrayContaining([
                { kind: "manufacturerEquals", value: "Example Co." },
              ]),
            }),
          }),
        ),
      { timeout: 1_000 },
    );

    fireEvent.click(screen.getByRole("button", { name: "Remove condition 2" }));
    await waitFor(
      () =>
        expect(requests.at(-1)).toEqual(
          expect.objectContaining({
            definition: expect.objectContaining({
              rules: [
                { kind: "historicalExpenseTrade", value: "finishes" },
                { kind: "productTagEquals", value: "collection:painting" },
              ],
            }),
          }),
        ),
      { timeout: 1_000 },
    );

    fireEvent.click(screen.getByRole("button", { name: "Add condition" }));
    fireEvent.change(
      screen.getByRole("textbox", { name: "Condition 3 value" }),
      { target: { value: "studio" } },
    );
    expect(screen.getByRole("combobox", { name: "Condition 1 type" })).toBe(
      firstCondition,
    );
    await waitFor(
      () =>
        expect(requests.at(-1)).toEqual(
          expect.objectContaining({
            definition: expect.objectContaining({
              rules: [
                { kind: "historicalExpenseTrade", value: "finishes" },
                { kind: "productTagEquals", value: "collection:painting" },
                { kind: "locationNameContains", value: "studio" },
              ],
            }),
          }),
        ),
      { timeout: 1_000 },
    );
  }, 20_000);

  it("keeps the last valid preview while a text condition is blank", async () => {
    renderPage();
    await screen.findByText("Sample paint roller");
    fireEvent.click(
      screen.getByRole("button", { name: /Edit temporary rules/ }),
    );

    const requestCount = requests.length;
    vi.useFakeTimers();
    try {
      fireEvent.change(
        screen.getByRole("textbox", { name: "Condition 2 value" }),
        { target: { value: "" } },
      );

      expect(
        screen.getByText("Preview uses the last valid rules"),
      ).toBeVisible();
      expect(screen.getByText("Sample paint roller")).toBeVisible();
      // The debounced preview request is a real setTimeout in the component;
      // fake timers let this assertion stay fast while still failing if a
      // request fires for an in-flight blank condition.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(requests).toHaveLength(requestCount);
    } finally {
      vi.useRealTimers();
    }
  });
});
