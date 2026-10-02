import { expenseOut } from "@cubby/schemas/project";
import { testCompleteDataQuality, testShortcode } from "@cubby/schemas/testing";
import {
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import {
  useCreateProjectFromTasksAction,
  useMarkExpensePurchasedAction,
} from "./tracker-entity-actions";

const plannedExpense = expenseOut.parse({
  id: testShortcode("expense", "EXP-2345"),
  name: "Paint",
  cost: 42,
  date: "2026-08-18",
  costType: "materials",
  trade: "building",
  lineKind: "principal",
  lineBasis: "item_line",
  future: true,
  vendor: null,
  vendorId: null,
  vendorLogo: null,
  projectId: null,
  projectName: null,
  productId: null,
  productName: null,
  productQuantity: null,
  purchaseId: null,
  orderId: null,
  orderUrl: null,
  notes: null,
  url: null,
  purchaseDate: null,
  purchaseDisplayLabel: null,
  sourceClaims: [],
  beneficiaries: [],
  funders: [],
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  dataQuality: testCompleteDataQuality(),
});

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  harness.dispose();
});

function CreateProjectActionHarness({
  onResolved,
}: {
  onResolved: (success: boolean) => void;
}) {
  const action = useCreateProjectFromTasksAction();
  const stageTasks = () => {
    const pending = action.run?.([
      { id: testShortcode("task", "TSK-2345"), name: "Prep" },
      { id: testShortcode("task", "TSK-2346"), name: "Install" },
    ]);
    if (pending) void pending.then((result) => onResolved(result.success));
  };

  return (
    <>
      <button type="button" onClick={stageTasks}>
        Stage project from tasks
      </button>
      {action.dialog}
    </>
  );
}

describe("tracker entity actions", () => {
  it("keeps Mark purchased refused for already-purchased or adjustment records", async () => {
    const { result } = renderHook(() => useMarkExpensePurchasedAction(), {
      wrapper: harness.wrapper,
    });
    await waitFor(() => expect(result.current).not.toBeNull());
    const purchased = expenseOut.parse({ ...plannedExpense, future: false });
    const adjustment = expenseOut.parse({ ...plannedExpense, lineKind: "tax" });

    expect(
      result.current.availability?.({
        entity: "expense",
        surface: "inspector",
        rows: [purchased],
      }),
    ).toEqual({ status: "disabled", reason: "Already purchased" });
    expect(
      result.current.availability?.({
        entity: "expense",
        surface: "row",
        rows: [adjustment],
      }),
    ).toEqual({
      status: "disabled",
      reason: "Adjustments aren't classified",
    });
    expect(
      result.current.availability?.({
        entity: "expense",
        surface: "row",
        rows: [plannedExpense],
      }),
    ).toEqual({ status: "available" });
  });

  it("opens the specialized project transaction with its staged task selection", async () => {
    const resolved: boolean[] = [];
    render(
      <CreateProjectActionHarness
        onResolved={(success) => resolved.push(success)}
      />,
      { wrapper: harness.wrapper },
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Stage project from tasks" }),
    );
    expect(
      await screen.findByRole("heading", { name: "New Project From Tasks" }),
    ).toBeVisible();
    expect(
      screen.getByText("Create a project and move 2 selected tasks onto it."),
    ).toBeVisible();
    await waitFor(() => expect(resolved).toEqual([true]));
    expect(harness.queryClient.getMutationCache().getAll()).toHaveLength(0);
  });
});
