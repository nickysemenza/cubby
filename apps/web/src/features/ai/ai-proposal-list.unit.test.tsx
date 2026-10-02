/**
 * The list's three promises: the count reflects what is still open, a settled
 * row leaves at once (and comes back if the write fails), and "Accept all"
 * means every visible row — not every row the caller ever passed.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AiProposalList, type AiProposalRow } from "./ai-proposal-list";

const rows: AiProposalRow[] = [
  { id: "a", title: "Blue tarp clamp", reasoning: "Seen on the top shelf." },
  { id: "b", title: "Spool of cable", reasoning: "Orange spool, left side." },
  { id: "c", title: "Box of screws", reasoning: "Labelled bin." },
];

const setup = (props: Partial<Parameters<typeof AiProposalList>[0]> = {}) =>
  render(
    <AiProposalList
      heading="Detected items"
      rows={rows}
      onAccept={vi.fn()}
      onReject={vi.fn()}
      {...props}
    />,
  );

describe("AiProposalList counts", () => {
  it("counts the rows still open", () => {
    setup();
    expect(screen.getByText("Detected items · 3")).toBeVisible();
  });

  it("renders nothing once every row is settled", async () => {
    const { container } = setup();
    fireEvent.click(screen.getByRole("button", { name: /Reject all/ }));
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});

describe("AiProposalList removal", () => {
  it("removes a row the moment it is accepted, before the caller drops it", async () => {
    const onAccept = vi.fn();
    setup({ onAccept });

    fireEvent.click(screen.getAllByRole("button", { name: /^Accept$/ })[0]!);

    await waitFor(() =>
      expect(screen.queryByText("Blue tarp clamp")).toBeNull(),
    );
    expect(onAccept).toHaveBeenCalledWith("a");
    // The caller still holds all three rows — the list is ahead of it.
    expect(screen.getByText("Detected items · 2")).toBeVisible();
  });

  /**
   * The failure this guards: an optimistic removal that is never undone tells
   * someone an item was stocked when the write threw.
   */
  it("puts a row back when the write rejects", async () => {
    const onAccept = vi.fn().mockRejectedValue(new Error("offline"));
    setup({ onAccept });

    fireEvent.click(screen.getAllByRole("button", { name: /^Accept$/ })[0]!);

    await waitFor(() =>
      expect(screen.getByText("Detected items · 3")).toBeVisible(),
    );
    expect(screen.getByText("Blue tarp clamp")).toBeVisible();
  });
});

describe("AiProposalList accept all", () => {
  it("accepts every visible row, one at a time", async () => {
    const onAccept = vi.fn();
    setup({ onAccept });

    fireEvent.click(screen.getByRole("button", { name: /Accept all/ }));

    await waitFor(() => expect(onAccept).toHaveBeenCalledTimes(3));
    expect(onAccept.mock.calls.map(([id]) => id)).toEqual(["a", "b", "c"]);
  });

  it("skips rows already rejected", async () => {
    const onAccept = vi.fn();
    const onReject = vi.fn();
    setup({ onAccept, onReject });

    fireEvent.click(screen.getAllByRole("button", { name: /^Reject$/ })[1]!);
    await waitFor(() =>
      expect(screen.queryByText("Spool of cable")).toBeNull(),
    );

    fireEvent.click(screen.getByRole("button", { name: /Accept all/ }));
    await waitFor(() => expect(onAccept).toHaveBeenCalledTimes(2));
    expect(onAccept.mock.calls.map(([id]) => id)).toEqual(["a", "c"]);
  });

  it("hands a single-request bulk accept straight to onAcceptAll", async () => {
    const onAccept = vi.fn();
    const onAcceptAll = vi.fn();
    setup({ onAccept, onAcceptAll, acceptAllLabel: "Create 3 products" });

    fireEvent.click(screen.getByRole("button", { name: /Create 3 products/ }));

    await waitFor(() => expect(onAcceptAll).toHaveBeenCalledOnce());
    expect(onAccept).not.toHaveBeenCalled();
  });

  it("offers no per-row accept when the surface has none", () => {
    setup({ onAccept: undefined, onAcceptAll: vi.fn() });
    expect(screen.queryAllByRole("button", { name: /^Accept$/ })).toHaveLength(
      0,
    );
    expect(screen.getByRole("button", { name: /Accept all/ })).toBeVisible();
  });

  it("keeps rejecting available while bulk accept is unavailable", () => {
    setup({ acceptAllDisabled: true });
    expect(screen.getByRole("button", { name: /Accept all/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Reject all/ })).toBeEnabled();
  });
});

describe("AiProposalList evidence", () => {
  it("shows each row's reasoning as text, not a tooltip", () => {
    setup();
    const reasoning = screen.getByText("Orange spool, left side.");
    expect(reasoning).toBeVisible();
    expect(reasoning).not.toHaveAttribute("title");
  });
});
