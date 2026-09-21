import { relatedSummaryOutput } from "@cubby/schemas/related-view";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { relatedData } from "~/lib/related-data.functions";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import {
  type RelationshipSummaryOperations,
  RelationshipSummaryTable,
} from "./relationship-summary-table";

const summary = relatedSummaryOutput.parse({
  data: [
    {
      target: {
        entity: "product",
        id: "PRD-TEST",
        label: "Brush",
        image: {
          id: "IMG-BRUSH",
          url: "https://example.com/brush.jpg",
          filename: "brush.jpg",
          contentType: "image/jpeg",
        },
      },
      expenseCount: 2,
      purchaseCount: 1,
      unpricedExpenseCount: 0,
      itemSpend: 18.5,
      sharedChargeSpend: 0,
      netSpend: 18.5,
      incomplete: false,
      latestActivity: "2026-01-02",
      knownAcquiredUnits: 3,
      unknownAcquisitionQuantityCount: 1,
    },
  ],
  count: 1,
  totals: {
    expenseCount: 2,
    purchaseCount: 1,
    unpricedExpenseCount: 0,
    itemSpend: 18.5,
    sharedChargeSpend: 0,
    netSpend: 18.5,
    incomplete: false,
    knownAcquiredUnits: 3,
    unknownAcquisitionQuantityCount: 1,
  },
  nextOffset: null,
});

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  harness.dispose();
});

function createOperations(output = summary): RelationshipSummaryOperations {
  return {
    summary: relatedData.summary.withTransport(async () => output),
  };
}

async function renderTable(operations: RelationshipSummaryOperations) {
  await act(async () => {
    await harness.loadRouter();
  });
  return render(
    <RelationshipSummaryTable
      relationKey="vendor.products"
      sourceId="VEN-TEST"
      columns={["target", "acquired", "netSpend"]}
      defaultSort={{ field: "latestActivity", direction: "desc" }}
      emptyCopy="Nothing yet."
      expenseHref={() => "/expenses?vendor=VEN-TEST"}
      operations={operations}
    />,
    { wrapper: harness.routerWrapper },
  );
}

describe("RelationshipSummaryTable", () => {
  it("shows item and shared-charge components with incomplete coverage", async () => {
    const allocation = relatedSummaryOutput.parse({
      ...summary,
      data: [
        {
          ...summary.data[0],
          target: null,
          itemSpend: 80,
          sharedChargeSpend: 7.25,
          netSpend: 87.25,
          incomplete: true,
        },
      ],
      totals: {
        ...summary.totals,
        itemSpend: 80,
        sharedChargeSpend: 7.25,
        netSpend: 87.25,
        incomplete: true,
      },
    });
    await act(async () => {
      await harness.loadRouter();
    });
    render(
      <RelationshipSummaryTable
        relationKey="purchase.projects"
        sourceId="PUR-TEST"
        columns={["target", "items", "sharedCharges", "netSpend", "coverage"]}
        defaultSort={{ field: "netSpend", direction: "desc" }}
        emptyCopy="Nothing yet."
        nullLabel="Unassigned"
        expenseHref={() => "/expenses?purchaseId=PUR-TEST"}
        operations={createOperations(allocation)}
      />,
      { wrapper: harness.routerWrapper },
    );

    expect(await screen.findByText("Unassigned")).toBeVisible();
    expect(screen.getByText("Incomplete")).toBeVisible();
    expect(
      screen.getByText(/\$80\.00 items \+ \$7\.25 shared = \$87\.25 total/),
    ).toBeVisible();
  });

  it("renders typed aggregate rows through the real table and operation descriptor", async () => {
    await renderTable(createOperations());

    expect(await screen.findByText("Brush")).toBeVisible();
    expect(screen.getByText("+1?")).toBeVisible();
    expect(screen.getByText(/\$18\.50 net/)).toBeVisible();
    expect(
      screen.getByRole("link", { name: "View Brush expenses" }),
    ).toHaveAttribute("href", "/expenses?vendor=VEN-TEST");
  });

  it("preserves a null relationship bucket as a warning-labelled ledger scope", async () => {
    const nullTarget = relatedSummaryOutput.parse({
      ...summary,
      data: [{ ...summary.data[0], target: null }],
    });
    await act(async () => {
      await harness.loadRouter();
    });
    render(
      <RelationshipSummaryTable
        relationKey="product.vendors"
        sourceId="PRD-TEST"
        columns={["target", "expenses", "netSpend"]}
        defaultSort={{ field: "latestActivity", direction: "desc" }}
        emptyCopy="Nothing yet."
        nullLabel="No purchase/vendor"
        expenseHref={() => "/expenses?productId=PRD-TEST&vendor=__none__"}
        operations={createOperations(nullTarget)}
      />,
      { wrapper: harness.routerWrapper },
    );

    expect(await screen.findByText("No purchase/vendor")).toHaveClass(
      "text-warning-ink",
    );
    expect(
      screen.getByRole("link", { name: "View No purchase/vendor expenses" }),
    ).toHaveAttribute("href", "/expenses?productId=PRD-TEST&vendor=__none__");
  });
});
