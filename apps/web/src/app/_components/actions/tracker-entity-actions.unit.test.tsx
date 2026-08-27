import { expenseOut } from "@cubby/schemas/project";
import { testShortcode } from "@cubby/schemas/testing";
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  useCreateProjectFromTasksAction,
  useMarkExpensePurchasedAction,
  useMoveToProjectEntityAction,
} from "./tracker-entity-actions";

const mutation = vi.hoisted(() => ({
  bulk: vi.fn().mockResolvedValue({ updated: 1, sideEffects: null }),
  update: vi.fn().mockResolvedValue({}),
}));

vi.mock("../hooks/useActionMutation", () => ({
  useActionMutation: () => ({ isPending: false, mutateAsync: mutation.bulk }),
}));

vi.mock("../hooks/useUpdateMutation", () => ({
  useUpdateMutation: () => ({
    isPending: false,
    mutateAsync: mutation.update,
  }),
}));

vi.mock("../tracker/move-to-project-dialog", () => ({
  MoveToProjectDialog: ({
    onOpenChange,
    onConfirm,
  }: {
    onOpenChange: (open: boolean) => void;
    onConfirm: (projectId: null) => Promise<void>;
  }) => (
    <>
      <button type="button" onClick={() => onOpenChange(false)}>
        Cancel move
      </button>
      <button type="button" onClick={() => void onConfirm(null)}>
        Confirm move
      </button>
    </>
  ),
}));

vi.mock("../tracker/set-field-dialog", () => ({
  SetFieldDialog: () => null,
}));
vi.mock("../tracker/set-task-status-dialog", () => ({
  SetTaskStatusDialog: () => null,
}));
vi.mock("../tracker/set-due-date-dialog", () => ({
  SetDueDateDialog: () => null,
}));
vi.mock("~/app/expenses/settle-expense-dialog", () => ({
  SettleExpenseDialog: () => null,
}));
vi.mock("~/app/tasks/create-project-from-tasks-dialog", () => ({
  CreateProjectFromTasksDialog: () => null,
}));

describe("tracker entity actions", () => {
  it("keeps selection while a staged dialog is open and clears only on success", async () => {
    const { result, rerender } = renderHook(() =>
      useMoveToProjectEntityAction("expense"),
    );
    const expenseRow = {
      id: "EXP-2345",
      name: "Paint",
      projectId: null,
    };
    let pending!: Promise<{ success: boolean }>;
    act(() => {
      pending = result.current.run?.([expenseRow]) as Promise<{
        success: boolean;
      }>;
    });
    rerender();
    const view = render(result.current.dialog);

    fireEvent.click(screen.getByRole("button", { name: "Cancel move" }));
    await expect(pending).resolves.toEqual({ success: false });
    expect(mutation.bulk).not.toHaveBeenCalled();

    act(() => {
      pending = result.current.run?.([expenseRow]) as Promise<{
        success: boolean;
      }>;
    });
    rerender();
    view.rerender(result.current.dialog);
    fireEvent.click(screen.getByRole("button", { name: "Confirm move" }));
    await expect(pending).resolves.toEqual({ success: true });
    expect(mutation.bulk).toHaveBeenCalledWith({
      ids: ["EXP-2345"],
      data: { projectId: null },
    });
  });

  it("keeps Mark purchased single-record and data-aware", () => {
    const { result } = renderHook(() => useMarkExpensePurchasedAction());
    const base = expenseOut.parse({
      id: testShortcode("expense", "EXP-2345"),
      name: "Paint",
      cost: 42,
      date: "2026-08-18",
      costType: "materials",
      trade: "building",
      lineKind: "principal",
      lineBasis: "item_line",
      future: false,
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
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
    });
    const purchased = base;
    const planned = expenseOut.parse({ ...base, future: true });
    const adjustment = expenseOut.parse({ ...planned, lineKind: "tax" });

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
        surface: "inspector",
        rows: [planned],
      }),
    ).toEqual({ status: "available" });
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
  });

  it("retains selection for the specialized create-project transaction", async () => {
    const { result } = renderHook(() => useCreateProjectFromTasksAction());
    await expect(
      result.current.run?.([
        { id: "TSK-2345", name: "Prep" },
        { id: "TSK-2346", name: "Install" },
      ]),
    ).resolves.toEqual({ success: true });
  });
});
