import { reportCommand } from "@cubby/schemas/entity-report";
import { fireEvent, render, screen } from "@testing-library/react";
import { fromPartial } from "@total-typescript/shoehorn";
import { expect, it, vi } from "vitest";

import { CommandButton, type ReportCommands } from "./report-commands";

// Shared command operands must be reviewed before a report can send a write.
it("collects declared report command inputs before dispatching their exact operand", () => {
  const run = vi.fn();
  const command = reportCommand.parse({
    id: "synthetic-scale",
    label: "Change portion",
    prominent: false,
    confirm: null,
    inputs: [
      {
        kind: "number",
        key: "scale",
        label: "Portion",
        initial: null,
        min: 0.1,
      },
    ],
    request: {
      kind: "meal-scale-recipe",
      mealRecipeId: crypto.randomUUID(),
      scale: null,
    },
  });
  render(
    <CommandButton
      command={command}
      commands={fromPartial<ReportCommands>({
        pending: false,
        run,
        runsFor: () => [],
      })}
    />,
  );
  const action = screen.getByRole("button", { name: "Change portion" });
  expect(action).toBeDisabled();
  expect(run).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole("spinbutton", { name: "Portion" }), {
    target: { value: "2" },
  });
  fireEvent.click(action);
  expect(run).toHaveBeenCalledWith({ ...command.request, scale: 2 });
});
