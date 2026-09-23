import { testShortcode } from "@cubby/schemas/testing";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { entityGraph } from "~/entities/entity-graph.functions";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import {
  type DeleteEntityActionCommands,
  deleteDescriptionForEntity,
  useDeleteEntityAction,
} from "./delete-entity-action";
import type { EntityActionRow } from "./entity-actions";

const expenseRow = {
  id: testShortcode("expense", "EXP-4K7M"),
  name: "Router gasket",
} satisfies EntityActionRow;

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  harness.dispose();
});

type DeleteResult = Awaited<ReturnType<DeleteEntityActionCommands["remove"]>>;

function deleteCommands(
  remove: (ids: readonly string[]) => Promise<DeleteResult>,
): DeleteEntityActionCommands {
  return { isPending: false, remove };
}

function DeleteActionHarness({
  commands,
  onResolved,
  connections,
}: {
  commands: DeleteEntityActionCommands;
  onResolved: (success: boolean) => void;
  connections?: typeof entityGraph.connections;
}) {
  const action = useDeleteEntityAction("expense", commands, {
    impactPreviewOperations: { connections },
  });
  const stageDelete = () => {
    const pending = action.run?.([expenseRow]);
    if (pending) void pending.then((result) => onResolved(result.success));
  };

  return (
    <>
      <button type="button" onClick={stageDelete}>
        Stage expense deletion
      </button>
      {action.dialog}
    </>
  );
}

describe("generated CRUD delete action", () => {
  it("describes a permanent removal without a per-entity branch", () => {
    expect(deleteDescriptionForEntity("task")).toContain(
      "permanently remove this task",
    );
  });

  it("confirms through the command port, resolves selection, and returns to the list", async () => {
    const removedIds: Array<readonly string[]> = [];
    const resolved: boolean[] = [];
    render(
      <DeleteActionHarness
        commands={deleteCommands(async (ids) => {
          removedIds.push(ids);
          return {
            ok: true,
            entity: "expense",
            id: ids[0] ?? "",
            changed: true,
          };
        })}
        onResolved={(success) => resolved.push(success)}
      />,
      { wrapper: harness.wrapper },
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Stage expense deletion" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Delete 1 Expense?" }),
    ).toBeVisible();
    expect(screen.getByText("Router gasket")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(removedIds).toEqual([[expenseRow.id]]));
    await waitFor(() => expect(resolved).toEqual([true]));
    await waitFor(() =>
      expect(harness.router.state.location.pathname).toBe("/expenses"),
    );
  });

  it("keeps the dialog open and exposes an operation refusal", async () => {
    const resolved: boolean[] = [];
    render(
      <DeleteActionHarness
        commands={deleteCommands(async () => ({
          ok: false,
          issues: [
            {
              message: "This expense is linked to a purchase.",
              source: "server",
            },
          ],
        }))}
        onResolved={(success) => resolved.push(success)}
      />,
      { wrapper: harness.wrapper },
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Stage expense deletion" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

    expect(
      await screen.findByText("This expense is linked to a purchase."),
    ).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "Delete 1 Expense?" }),
    ).toBeVisible();
    expect(resolved).toEqual([]);
    expect(harness.router.state.location.pathname).toBe("/");
  });

  it("shows an advisory connection impact preview without gating the confirm action", async () => {
    const resolved: boolean[] = [];
    const connections = entityGraph.connections.withTransport(
      async ({ input }) => ({
        id: input.id,
        kind: "expense",
        redirectedFrom: null,
        groups: [
          {
            direction: "incoming",
            edgeKey: "ExpenseSplit.expenseId",
            label: "Expense splits",
            role: "owned-child",
            otherKind: "expense",
            count: 2,
            items: [],
            disposition: {
              code: "block-live-splits",
              effect: "block",
              description: "Remove the splits first.",
            },
          },
        ],
      }),
    );
    render(
      <DeleteActionHarness
        commands={deleteCommands(async (ids) => ({
          ok: true,
          entity: "expense",
          id: ids[0] ?? "",
          changed: true,
        }))}
        onResolved={(success) => resolved.push(success)}
        connections={connections}
      />,
      { wrapper: harness.wrapper },
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Stage expense deletion" }),
    );
    expect(await screen.findByText("Blocks the delete")).toBeVisible();
    expect(screen.getByText("Remove the splits first.")).toBeVisible();

    // Advisory only: the preview never disables or changes the confirm
    // action, even when it surfaces a blocking disposition.
    const confirm = screen.getByRole("button", { name: "Delete" });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    await waitFor(() => expect(resolved).toEqual([true]));
  });
});
