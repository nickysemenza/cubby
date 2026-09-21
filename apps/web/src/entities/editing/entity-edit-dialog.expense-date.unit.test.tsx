import { expenseOut } from "@cubby/schemas/project";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { entityMutation } from "~/entities/entity-mutation.functions";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";
import { mock } from "~/lib/test/mock-schema";
import { entityBrowserMutationResultSchema } from "~/server/entity-kernel/contracts";

import { EntityEditDialog } from "./entity-edit-dialog";
import { createEntityMutationPort } from "./use-entity-commands";

let harness: ReturnType<typeof createBrowserTestHarness>;
beforeEach(() => {
  harness = createBrowserTestHarness();
});
afterEach(() => {
  harness.dispose();
});

function renderExpense(intent: "date" | "cost", date: string | null) {
  const record = mock(expenseOut, { overrides: { cost: 0, date } });
  const transport = vi.fn(async () =>
    entityBrowserMutationResultSchema.parse({
      action: "update",
      entity: "expense",
      item: record,
      sideEffects: { backgroundBatches: [] },
    }),
  );
  const mutation = entityMutation.mutate.withTransport(transport);
  const mutationPort = createEntityMutationPort({
    execute: (command) => mutation.forEntity(command.entity).call(command),
  });
  render(
    <EntityEditDialog
      open
      onOpenChange={vi.fn()}
      mutationPort={mutationPort}
      request={{ entity: "expense", operation: "update", intent, record }}
    />,
    { wrapper: harness.wrapper },
  );
  return transport;
}

it("uses the existing cost when clearing a date in the date-only editor", async () => {
  const transport = renderExpense("date", "2026-01-02");
  fireEvent.click(await screen.findByRole("button", { name: "Date unknown" }));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() =>
    expect(transport).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ data: { date: null } }),
      }),
    ),
  );
});

it("retains a cost draft and explains the missing date before submitting", async () => {
  const transport = renderExpense("cost", null);
  const cost = await screen.findByLabelText("Cost", { exact: true });
  fireEvent.change(cost, { target: { value: "12" } });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect(
    await screen.findByText(/A date is required unless the cost is \$0/),
  ).toBeInTheDocument();
  expect(cost).toHaveValue(12);
  expect(transport).not.toHaveBeenCalled();
});
