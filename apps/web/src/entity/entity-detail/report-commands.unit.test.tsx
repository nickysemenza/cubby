import { reportCommand } from "@cubby/schemas/entity-report";
import { fireEvent, render, screen, within } from "@testing-library/react";
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
      kind: "operation",
      operation: "meal.updateRecipe",
      body: { id: crypto.randomUUID(), scale: null },
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
  expect(run).toHaveBeenCalledWith({
    ...command.request,
    body: {
      ...(command.request.kind === "operation" ? command.request.body : {}),
      scale: 2,
    },
  });
});

// Failure mode: a declared confirmation is bypassed, or cancelling dispatches a write.
it("requires declared confirmation and preserves reviewed operands after cancellation", () => {
  const run = vi.fn();
  const command = reportCommand.parse({
    id: "synthetic-review",
    label: "Apply correction",
    prominent: false,
    confirm: "Apply the reviewed correction?",
    request: {
      kind: "operation",
      operation: "problems.resolveRunFinding",
      body: {
        id: crypto.randomUUID(),
        action: "apply",
        reviewedFingerprint: "synthetic-fingerprint",
      },
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
  fireEvent.click(screen.getByRole("button", { name: "Apply correction" }));
  expect(run).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(run).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Apply correction" }));
  fireEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", {
      name: "Apply correction",
    }),
  );
  expect(run).toHaveBeenCalledWith(command.request);
});
