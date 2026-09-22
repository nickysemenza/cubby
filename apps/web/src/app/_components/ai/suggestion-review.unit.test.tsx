import type { FieldSuggestion } from "@cubby/schemas/ai";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  actionableSuggestion,
  SuggestionReview,
  SuggestionVisitProvider,
} from "./suggestion-review";

afterEach(() => vi.restoreAllMocks());

const suggestion: FieldSuggestion = {
  value: "tools",
  label: "Tools",
  confidence: "high",
  probability: 0.97,
  detail: null,
  reasoning: "",
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

  it("requires 0.95 for a provided alternative even when the stored value is explicit None", () => {
    expect(
      actionableSuggestion({ ...suggestion, probability: 0.9 }, null, true),
    ).toBe(false);
    expect(
      actionableSuggestion({ ...suggestion, probability: 0.95 }, null, true),
    ).toBe(true);
  });

  it("shows both values, requires acceptance, and retains the proposal after a failed save", async () => {
    const errorSpy = vi.spyOn(toast, "error").mockImplementation(() => "");
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
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("unavailable");
    expect(screen.getByText("Materials")).toBeInTheDocument();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Use suggestion" }));
    await waitFor(() =>
      expect(screen.queryByText("Suggested: Tools")).not.toBeInTheDocument(),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
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
