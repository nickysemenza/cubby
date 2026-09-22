import type { FieldSuggestion } from "@cubby/schemas/ai";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  actionableSuggestion,
  SuggestionReview,
  SuggestionVisitProvider,
} from "./suggestion-review";

const suggestion: FieldSuggestion = {
  value: "tools",
  label: "Tools",
  confidence: "high",
  probability: 0.97,
  detail: null,
  reasoning: "",
  alternatives: [],
  operation: "set",
  removals: [],
};

const removeSuggestion: FieldSuggestion = {
  value: "apparel, jacquemus",
  label: "Remove apparel, jacquemus",
  confidence: "high",
  probability: 0.9,
  detail: "restates classification, manufacturer",
  reasoning: "",
  alternatives: [],
  operation: "remove",
  removals: [
    { value: "jacquemus", probability: 0.95, reason: "restates manufacturer" },
    { value: "apparel", probability: 0.9, reason: "restates classification" },
  ],
};

describe("inline suggestion review", () => {
  it.each([
    [null, 0.849, false],
    [null, 0.85, true],
    ["", 0.85, true],
    ["materials", 0.949, false],
    ["materials", 0.95, true],
    ["other", 0.9, false],
    ["tools", 1, false],
    [null, null, false],
  ] as const)(
    "gates current=%s probability=%s",
    (current, probability, shown) => {
      expect(
        actionableSuggestion({ ...suggestion, probability }, current),
      ).toBe(shown);
    },
  );

  it.each([
    [0.849, false],
    [0.85, true],
    [0.95, true],
  ] as const)(
    "a remove (prune) suggestion gates at 0.85, never the 0.95 alternative floor — probability=%s",
    (probability, shown) => {
      expect(
        actionableSuggestion(
          { ...removeSuggestion, probability },
          "apparel, jacquemus, mount",
        ),
      ).toBe(shown);
      // `alternative: true` (the "provided" basisMode gate) never raises a
      // remove op's floor to 0.95.
      expect(
        actionableSuggestion({ ...removeSuggestion, probability }, null, true),
      ).toBe(shown);
    },
  );

  it("shows a remove proposal's own apply/secondary labels and muted reason", () => {
    const save = vi.fn().mockResolvedValue(undefined);
    render(
      <SuggestionReview
        suggestion={removeSuggestion}
        currentValue="apparel, jacquemus, mount"
        questionKey="tags"
        onApply={save}
      >
        <span>mount</span>
      </SuggestionReview>,
    );
    // The current chips (`children`) always render for a remove proposal —
    // there is no "replace with a new value" arrow flow.
    expect(screen.getByText("mount")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Remove apparel, jacquemus — restates classification, manufacturer",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Use suggestion" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove tags" }));
    expect(save).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Keep" })).toBeInTheDocument();
  });

  it("requires 0.95 for a provided alternative even when the stored value is explicit None", () => {
    expect(
      actionableSuggestion({ ...suggestion, probability: 0.9 }, null, true),
    ).toBe(false);
    expect(
      actionableSuggestion({ ...suggestion, probability: 0.95 }, null, true),
    ).toBe(true);
  });

  it("shows both values, requires acceptance, and retains the proposal after a failed save", async () => {
    const save = vi
      .fn()
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValue(undefined);
    render(
      <SuggestionReview
        suggestion={suggestion}
        currentValue="materials"
        currentLabel="Materials"
        questionKey="one"
        onApply={save}
      />,
    );
    expect(screen.getByText("Materials")).toBeInTheDocument();
    expect(screen.getByText("Suggested: Tools")).toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Use suggestion" }));
    await screen.findByRole("alert");
    expect(screen.getByText("Materials")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Use suggestion" }));
    await waitFor(() =>
      expect(screen.queryByText("Suggested: Tools")).not.toBeInTheDocument(),
    );
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("keeps the existing editor once in the comparison and available after dismissal", () => {
    const edit = vi.fn();
    render(
      <SuggestionReview
        suggestion={suggestion}
        currentValue="materials"
        questionKey="editor"
        onApply={() => {}}
      >
        <button type="button" onClick={edit}>
          Materials
        </button>
      </SuggestionReview>,
    );
    expect(screen.getAllByText("Materials")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Materials" }));
    expect(edit).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Keep current" }));
    expect(screen.queryByText("Suggested: Tools")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Materials" }));
    expect(edit).toHaveBeenCalledTimes(2);
  });

  it("remembers Keep current across page changes, but new evidence and a new visit can propose again", () => {
    const content = (key: string | null) => (
      <SuggestionVisitProvider>
        {key ? (
          <SuggestionReview
            suggestion={suggestion}
            currentValue="materials"
            questionKey={key}
            onApply={() => {}}
          />
        ) : null}
      </SuggestionVisitProvider>
    );
    const view = render(content("first"));
    fireEvent.click(screen.getByRole("button", { name: "Keep current" }));
    view.rerender(content(null));
    view.rerender(content("first"));
    expect(screen.queryByText("Suggested: Tools")).not.toBeInTheDocument();
    view.rerender(content("changed"));
    expect(screen.getByText("Suggested: Tools")).toBeInTheDocument();
    view.unmount();
    render(content("first"));
    expect(screen.getByText("Suggested: Tools")).toBeInTheDocument();
  });
});
