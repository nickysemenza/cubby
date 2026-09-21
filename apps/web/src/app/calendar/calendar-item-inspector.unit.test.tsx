import type { CalendarItem } from "@cubby/schemas/calendar";
import { type ExpenseOut, expenseOut } from "@cubby/schemas/project";
import { testShortcode } from "@cubby/schemas/testing";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createEntityMutationPort } from "~/entities/editing/use-entity-commands";
import type { EntityMutationTransport } from "~/entities/entity-contracts";
import { entityMutation } from "~/entities/entity-mutation.functions";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";
import {
  entityBrowserMutationCommandSchema,
  type EntityBrowserMutationInput,
} from "~/server/entity-kernel/contracts";

import {
  CalendarInspectorBody,
  type CalendarItemInspectorOperations,
  EditableCalendarItem,
} from "./calendar-item-inspector";
import { calendarItemEditDescriptor } from "./calendar-kind-registry";

const expense: Extract<CalendarItem, { kind: "expense" }> = {
  kind: "expense",
  id: testShortcode("expense", "EXP-1111"),
  title: "Freezer tray",
  startDate: "2026-08-18",
  endDateExclusive: "2026-08-19",
  interaction: "move",
  cost: 79,
  future: true,
  vendor: "Target",
  trade: "other",
  projectName: null,
  productName: "Souper Cubes",
  coverImageUrl: null,
};

const savedExpense: ExpenseOut = expenseOut.parse({
  id: expense.id,
  name: "Large freezer tray",
  cost: 79,
  date: "2026-08-18",
  lineKind: "principal",
  costType: "materials",
  lineBasis: "item_line",
  trade: "other",
  future: true,
  vendor: "Target",
  vendorId: null,
  vendorLogo: null,
  projectId: null,
  projectName: null,
  productId: null,
  productName: "Souper Cubes",
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
  createdAt: new Date("2026-08-18T12:00:00Z"),
  updatedAt: new Date("2026-08-18T12:00:00Z"),
});

function editableDescriptor(item: CalendarItem) {
  const descriptor = calendarItemEditDescriptor(item);
  if (descriptor.mode !== "editable") {
    throw new Error("The test item must be editable.");
  }
  return descriptor;
}

function createCalendarOperations() {
  const requests: EntityBrowserMutationInput[] = [];
  let refusal: Error | undefined;
  const mutation = entityMutation.mutate.withTransport(async ({ input }) => {
    const command = entityBrowserMutationCommandSchema.parse(input);
    requests.push(command);
    if (refusal) throw refusal;
    if (command.action === "update" && command.entity === "expense") {
      return {
        action: "update" as const,
        entity: "expense" as const,
        item: savedExpense,
        sideEffects: { backgroundBatches: [] },
      };
    }
    throw new Error("Calendar inspector only issues expense updates.");
  });
  const transport: EntityMutationTransport = {
    execute: async (command) =>
      await mutation.forEntity(command.entity).call(command),
  };
  const inspectorOperations: CalendarItemInspectorOperations = {
    mutationPort: createEntityMutationPort(transport),
  };
  return {
    inspectorOperations,
    requests,
    refuse(error: Error) {
      refusal = error;
    },
  };
}

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  harness.dispose();
});

describe("EditableCalendarItem", () => {
  it("clears the date when the same edit sets a planned expense to zero", async () => {
    const calendar = createCalendarOperations();
    render(
      <EditableCalendarItem
        item={expense}
        edit={editableDescriptor(expense)}
        onCancel={() => undefined}
        operations={calendar.inspectorOperations}
      />,
      { wrapper: harness.wrapper },
    );
    expect(screen.queryByRole("button", { name: "Date unknown" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Planned cost"), {
      target: { value: "0" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Date unknown" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calendar.requests).toHaveLength(1));
    expect(calendar.requests[0]).toMatchObject({
      data: { cost: 0, date: null },
    });
  });

  it("submits one complete atomic update", async () => {
    const calendar = createCalendarOperations();
    render(
      <EditableCalendarItem
        item={expense}
        edit={editableDescriptor(expense)}
        onCancel={() => undefined}
        operations={calendar.inspectorOperations}
      />,
      { wrapper: harness.wrapper },
    );
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Large freezer tray" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(calendar.requests).toHaveLength(1));
    expect(calendar.requests[0]).toMatchObject({
      action: "update",
      entity: "expense",
      id: expense.id,
      data: {
        name: "Large freezer tray",
      },
    });
  });

  it("retains edited values and shows the inline error when saving fails", async () => {
    const calendar = createCalendarOperations();
    calendar.refuse(new Error("Ledger unavailable"));
    render(
      <EditableCalendarItem
        item={expense}
        edit={editableDescriptor(expense)}
        onCancel={() => undefined}
        operations={calendar.inspectorOperations}
      />,
      { wrapper: harness.wrapper },
    );
    const name = screen.getByLabelText("Name");
    fireEvent.change(name, { target: { value: "Keep this edit" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Ledger unavailable")).toBeInTheDocument();
    expect(name).toHaveValue("Keep this edit");
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("keeps plantings read-only with a full-record route", () => {
    const planting: Extract<CalendarItem, { kind: "planting" }> = {
      kind: "planting",
      id: testShortcode("planting", "PLT-3B2C"),
      milestone: "sowed",
      title: "Tomato · Brandywine",
      locationName: "Raised bed 2",
      plannedWindow: "Late spring",
      startDate: "2026-08-18",
      endDateExclusive: "2026-08-19",
      interaction: "read-only",
    };
    render(
      <CalendarInspectorBody item={planting} onCancel={() => undefined} />,
      { wrapper: harness.wrapper },
    );

    expect(
      screen.getByText(/Planting dates are edited from the planting/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Open full record" }),
    ).toHaveAttribute("href", `/plantings/${planting.id}`);
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });

  it("keeps actual expenses read-only with a full-record route", () => {
    render(
      <CalendarInspectorBody
        item={{ ...expense, interaction: "read-only", future: false }}
        onCancel={() => undefined}
      />,
      { wrapper: harness.wrapper },
    );

    expect(
      screen.getByText(/Recorded expenses stay read-only/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Open full record" }),
    ).toHaveAttribute("href", `/expenses/${expense.id}`);
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });
});
