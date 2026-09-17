import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { BulkActionDialog } from "./bulk-action-dialog";

/**
 * The `effect` seam, once. Eleven dialogs build on this shell and the
 * projection is declared in one place, so per-dialog tests would re-assert the
 * same mechanism — what needs pinning is that the shell renders `current →
 * next`, dims and counts the rows it would not change, and refuses to confirm
 * a selection containing a blocked row.
 */

const rows = [
  { id: "a", name: "Alpha", trade: "electrical" },
  { id: "b", name: "Bravo", trade: "plumbing" },
  { id: "c", name: "Charlie", trade: "plumbing" },
];

function renderDialog(
  effect?: (item: (typeof rows)[number]) => {
    from?: string;
    to: string;
    unchanged?: boolean;
    blocked?: string;
  },
) {
  return render(
    <BulkActionDialog
      open
      onOpenChange={() => {}}
      items={rows}
      action="Set Trade"
      actionLabel="Update"
      itemNoun="Task"
      description="Set a new trade."
      renderItem={(item) => item.name}
      effect={effect}
      onSubmit={vi.fn()}
      isPending={false}
    />,
  );
}

const confirmButton = () => screen.getByRole("button", { name: "Update" });
const rowFor = (name: string) => {
  const row = screen.getByText(name).closest("li");
  if (!(row instanceof HTMLLIElement)) throw new Error(`${name} row not found`);
  return row;
};

describe("BulkActionDialog effect projection", () => {
  it("renders current → next per row, dims and counts the unchanged ones", () => {
    renderDialog((item) => ({
      from: item.trade,
      to: "plumbing",
      unchanged: item.trade === "plumbing",
    }));

    // The changing row shows both halves; the arrow is decorative, so the
    // accessible name carries "changes to" instead.
    const alpha = rowFor("Alpha");
    expect(within(alpha).getByText("electrical")).toBeInTheDocument();
    expect(within(alpha).getByText("plumbing")).toBeInTheDocument();
    expect(alpha.className).not.toContain("opacity-60");

    // Already in the target state: still listed, but dimmed rather than hidden
    // — the operator picked these rows and should see what happened to them.
    expect(rowFor("Bravo").className).toContain("opacity-60");
    expect(rowFor("Charlie").className).toContain("opacity-60");

    expect(screen.getByText("2 of 3 already set")).toBeInTheDocument();
    expect(confirmButton()).toBeEnabled();
  });

  it("omits the projection entirely when no effect is supplied", () => {
    renderDialog();

    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.queryByText("2 of 3 already set")).not.toBeInTheDocument();
    expect(confirmButton()).toBeEnabled();
  });

  it("disables confirmation while any row is blocked, and says why", () => {
    renderDialog((item) => ({
      to: "plumbing",
      blocked:
        item.id === "a" ? "a location cannot be its own parent" : undefined,
    }));

    expect(confirmButton()).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "1 of 3 task cannot proceed: a location cannot be its own parent",
    );
  });

  it("honors a caller-owned submission gate without inventing a blocker", () => {
    render(
      <BulkActionDialog
        open
        onOpenChange={() => {}}
        items={rows}
        action="Set Trade"
        actionLabel="Update"
        itemNoun="Task"
        description="Set a new trade."
        renderItem={(item) => item.name}
        onSubmit={vi.fn()}
        isPending={false}
        submissionDisabled
      />,
    );

    expect(confirmButton()).toBeDisabled();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
