/**
 * The card's two promises that nothing else enforces: the keys the review
 * queue taught users work here too, and provenance is rendered rather than
 * quietly swallowed when a read path does carry it.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AiProposalCard, AiProvenance } from "./ai-proposal-card";

const base = {
  confidence: "high" as const,
  reasoning: "The label reads DeWalt.",
  provenance: <AiProvenance />,
};

describe("AiProposalCard keyboard handling", () => {
  /**
   * Accept holds focus so `↵` is the browser's own button activation. An
   * earlier version put the handler on the card wrapper — an affordance a
   * keyboard user could not reach and a screen reader could not name.
   */
  it("lands focus on Accept so Enter activates it natively", () => {
    render(<AiProposalCard {...base} onAccept={vi.fn()} onDismiss={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Accept" })).toHaveFocus();
  });

  it("falls back to Dismiss when there is nothing to accept", () => {
    render(<AiProposalCard {...base} onDismiss={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Dismiss" })).toHaveFocus();
  });

  it("dismisses on Escape from either action", () => {
    const onDismiss = vi.fn();
    render(
      <AiProposalCard {...base} onAccept={vi.fn()} onDismiss={onDismiss} />,
    );

    fireEvent.keyDown(screen.getByRole("button", { name: "Accept" }), {
      key: "Escape",
    });
    expect(onDismiss).toHaveBeenCalledOnce();

    fireEvent.keyDown(screen.getByRole("button", { name: "Dismiss" }), {
      key: "Escape",
    });
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });

  /**
   * The bug this guards: a proposal can hold a picker or a price input, and
   * Enter inside one belongs to that control. A handler on the card wrapper
   * would accept the proposal out from under a half-finished edit.
   */
  it("leaves Enter inside the proposal to the control that owns it", () => {
    const onAccept = vi.fn();
    render(
      <AiProposalCard {...base} onAccept={onAccept}>
        <input aria-label="Price" />
      </AiProposalCard>,
    );

    fireEvent.keyDown(screen.getByLabelText("Price"), { key: "Enter" });
    expect(onAccept).not.toHaveBeenCalled();
  });

  it("is inert and legend-free with no handlers", () => {
    render(<AiProposalCard {...base} />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("AiProposalCard content", () => {
  it("always shows the reasoning, never as a tooltip", () => {
    render(<AiProposalCard {...base} />);
    const reasoning = screen.getByText("The label reads DeWalt.");
    expect(reasoning).toBeVisible();
    expect(reasoning).not.toHaveAttribute("title");
  });

  it("renders model, age and cache status when the read path carries them", () => {
    render(
      <AiProposalCard
        {...base}
        provenance={
          <AiProvenance
            model="claude-sonnet-5"
            analyzedAt={new Date(Date.now() - 3 * 60 * 60 * 1000)}
            cacheStatus="hit"
          />
        }
      />,
    );
    expect(
      screen.getByText("Analyzed by claude-sonnet-5 · 3h ago · cache hit"),
    ).toBeVisible();
  });

  // A surface whose response carries no provenance renders nothing rather
  // than "unknown · unknown": the slot stays required so the gap is visible
  // in the source, not so the UI prints a placeholder.
  it("renders nothing when no part of the provenance is known", () => {
    const { container } = render(<AiProvenance />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the current value beside the proposed one", () => {
    render(
      <AiProposalCard
        {...base}
        diff={
          <>
            <span>Current</span>
            <span>Proposed</span>
          </>
        }
      />,
    );
    expect(screen.getByText("Current")).toBeVisible();
    expect(screen.getByText("Proposed")).toBeVisible();
  });
});
