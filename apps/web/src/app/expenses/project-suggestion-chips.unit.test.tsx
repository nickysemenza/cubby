import {
  expenseOut,
  expenseTradeAffinityOut,
  projectOptionsOut,
} from "@cubby/schemas/project";
import { testShortcode } from "@cubby/schemas/testing";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { project } from "~/app/projects/project.functions";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { expense as expenseOperations } from "./expense.functions";
import { ProjectSuggestionChips } from "./project-suggestion-chips";

const PROJECT_ID = testShortcode("project", "PRJ-2ABC");
const PROJECTS = [
  projectOptionsOut.parse({
    id: PROJECT_ID,
    name: "Workshop refresh",
    icon: null,
    effectiveStart: "2026-08-01",
    effectiveEnd: "2026-08-31",
  }),
];
const AFFINITY = [
  expenseTradeAffinityOut.parse({
    projectId: PROJECT_ID,
    trade: "electrical",
    count: 2,
  }),
];

const expense = expenseOut.parse({
  id: testShortcode("expense", "EXP-PLAN"),
  name: "Planned expense",
  cost: 0,
  projectId: null,
  date: "2026-08-12",
  lineKind: "principal",
  lineBasis: "item_line",
  costType: "materials",
  trade: "electrical",
  future: false,
  vendor: null,
  vendorId: null,
  vendorLogo: null,
  productId: null,
  productName: null,
  productQuantity: null,
  purchaseId: null,
  purchaseDate: null,
  purchaseDisplayLabel: null,
  orderId: null,
  orderUrl: null,
  notes: null,
  url: null,
  projectName: null,
  beneficiaries: [],
  funders: [],
  sourceClaims: [],
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
});

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
  const projectOptions = project.options.queryOptions();
  harness.queryClient.setQueryDefaults(projectOptions.queryKey, {
    staleTime: Number.POSITIVE_INFINITY,
  });
  harness.queryClient.setQueryData(projectOptions.queryKey, PROJECTS);

  const affinityOptions = expenseOperations.tradeAffinity.queryOptions();
  harness.queryClient.setQueryDefaults(affinityOptions.queryKey, {
    staleTime: Number.POSITIVE_INFINITY,
  });
  harness.queryClient.setQueryData(affinityOptions.queryKey, AFFINITY);
});

afterEach(() => {
  harness.dispose();
});

describe("ProjectSuggestionChips", () => {
  it("does not assign until the selected proposal is accepted", () => {
    const onAssign = vi.fn().mockResolvedValue(undefined);
    render(
      <ProjectSuggestionChips
        expense={expense}
        isPending={false}
        onAssign={onAssign}
      />,
      { wrapper: harness.wrapper },
    );

    fireEvent.click(screen.getByRole("button", { name: "Workshop refresh" }));

    expect(onAssign).not.toHaveBeenCalled();
    expect(screen.getByText(/Assign to Workshop refresh/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Accept" }));

    expect(onAssign).toHaveBeenCalledWith(PROJECT_ID);
  });
});
