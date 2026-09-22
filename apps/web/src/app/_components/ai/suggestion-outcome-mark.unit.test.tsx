import type {
  FieldSuggestion,
  FieldSuggestionOutcome,
} from "@cubby/schemas/ai";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  describeOutcome,
  SuggestionOutcomeMark,
} from "./suggestion-outcome-mark";

const suggestion: FieldSuggestion = {
  value: "materials",
  label: "Materials",
  detail: null,
  confidence: "high",
  probability: 0.91,
  reasoning: "",
  alternatives: [],
  operation: "set",
  removals: [],
};

const pickOutcome = (
  overrides: Partial<
    Extract<FieldSuggestionOutcome, { kind: "evaluated" }>
  > = {},
): FieldSuggestionOutcome => ({
  kind: "evaluated",
  answer: "pick",
  confidence: "high",
  probability: 0.91,
  alternatives: [],
  ...overrides,
});

describe("describeOutcome headline copy", () => {
  it("agrees with the current value", () => {
    expect(
      describeOutcome({
        outcome: pickOutcome(),
        suggestion,
        currentValue: "materials",
        currentLabel: "Materials",
      }),
    ).toBe("Agrees with Materials · 91%");
  });

  it("reads 'Filled in' when auto-filled rather than 'Agrees with'", () => {
    expect(
      describeOutcome({
        outcome: pickOutcome(),
        suggestion,
        currentValue: "materials",
        autoFilled: true,
      }),
    ).toBe("Filled in · 91%");
  });

  it("reads 'Suggested' for an actionable pick", () => {
    expect(
      describeOutcome({
        outcome: pickOutcome(),
        suggestion,
        currentValue: null,
        actionable: true,
      }),
    ).toBe("Suggested Materials · 91%");
  });

  it("reads 'Leaning' with the fill threshold on an empty field below the bar", () => {
    expect(
      describeOutcome({
        outcome: pickOutcome({ probability: 0.64 }),
        suggestion: { ...suggestion, probability: 0.64, label: "Other" },
        currentValue: null,
        actionable: false,
        alternative: false,
      }),
    ).toBe("Leaning Other · 64% — needs 85%");
  });

  it("reads 'Would pick' with the alternative threshold when the field already has a value", () => {
    expect(
      describeOutcome({
        outcome: pickOutcome({ probability: 0.62 }),
        suggestion: { ...suggestion, probability: 0.62 },
        currentValue: "tools",
        actionable: false,
      }),
    ).toBe("Would pick Materials · 62% — needs 95% to change");
  });

  it("reads 'Would pick' at the alternative threshold for a provided alternative on an empty field", () => {
    expect(
      describeOutcome({
        outcome: pickOutcome({ probability: 0.62 }),
        suggestion: { ...suggestion, probability: 0.62 },
        currentValue: null,
        alternative: true,
        actionable: false,
      }),
    ).toBe("Would pick Materials · 62% — needs 95% to change");
  });

  it("reads 'No good fit' for a declined fill target", () => {
    expect(
      describeOutcome({
        outcome: {
          kind: "evaluated",
          answer: "none",
          confidence: "medium",
          probability: 0.78,
          alternatives: [],
        },
        prune: false,
      }),
    ).toBe("No good fit · 78%");
  });

  it("reads 'Nothing to remove · closest' for a declined prune target with an alternative", () => {
    expect(
      describeOutcome({
        outcome: {
          kind: "evaluated",
          answer: "none",
          confidence: "medium",
          probability: 0.6,
          alternatives: [
            {
              value: "battery",
              label: "battery",
              detail: null,
              probability: 0.6,
            },
          ],
        },
        prune: true,
      }),
    ).toBe("Nothing to remove · closest battery 60% — needs 85%");
  });

  it("reads bare 'Nothing to remove' for a declined prune target with no alternatives", () => {
    expect(
      describeOutcome({
        outcome: {
          kind: "evaluated",
          answer: "none",
          confidence: "medium",
          probability: 0.6,
          alternatives: [],
        },
        prune: true,
      }),
    ).toBe("Nothing to remove");
  });

  it.each([
    ["no_signal", "Not checked — nothing to go on yet"],
    ["no_candidates", "Not checked — no candidates"],
    ["resolved", "Not checked — inherited"],
  ] as const)("reads the skipped reason for %s", (reason, expected) => {
    expect(describeOutcome({ outcome: { kind: "skipped", reason } })).toBe(
      expected,
    );
  });

  it("floors the percent so 0.949 never reads as 95%", () => {
    expect(
      describeOutcome({
        outcome: pickOutcome({ probability: 0.949 }),
        suggestion: { ...suggestion, probability: 0.949 },
        currentValue: "materials",
        currentLabel: "Materials",
      }),
    ).toBe("Agrees with Materials · 94%");
  });

  it("says 'confidence high' instead of a percent when probability is null (chat-tier roster overflow)", () => {
    expect(
      describeOutcome({
        outcome: {
          kind: "evaluated",
          answer: "pick",
          confidence: "high",
          probability: null,
          alternatives: [],
        },
        suggestion: { ...suggestion, probability: null },
        currentValue: null,
        actionable: true,
      }),
    ).toBe("Suggested Materials · confidence high");
  });

  it("returns an empty string with no outcome", () => {
    expect(describeOutcome({ outcome: null })).toBe("");
  });
});

describe("SuggestionOutcomeMark", () => {
  it("renders nothing when neither outcome nor suggestion is given", () => {
    const { container } = render(<SuggestionOutcomeMark />);
    expect(container).toBeEmptyDOMElement();
  });

  it("derives an evaluated/pick outcome from a bare suggestion", () => {
    render(
      <SuggestionOutcomeMark
        suggestion={suggestion}
        currentValue={null}
        actionable
      />,
    );
    expect(
      screen.getByRole("button", { name: "Suggested Materials · 91%" }),
    ).toBeInTheDocument();
  });

  it("shows the headline as visible text beside the glyph on the line surface", () => {
    render(
      <SuggestionOutcomeMark
        outcome={pickOutcome()}
        suggestion={suggestion}
        currentValue="materials"
        currentLabel="Materials"
        surface="line"
      />,
    );
    expect(screen.getByText("Agrees with Materials · 91%")).toBeInTheDocument();
  });

  it("stops a cell trigger's click/mousedown from reaching the row/cell selection handlers", () => {
    // A cell's selection starts on `TableCell`'s own `onMouseDown` — the mark
    // must never let that bubble up, or hovering/clicking it would also
    // select the cell. Listening at the document root avoids adding an
    // interactive-role wrapper just to observe the bubble.
    const onMouseDown = vi.fn();
    document.addEventListener("mousedown", onMouseDown);
    render(
      <SuggestionOutcomeMark
        outcome={pickOutcome()}
        suggestion={suggestion}
        currentValue={null}
        actionable
        surface="cell"
      />,
    );
    fireEvent.mouseDown(screen.getByRole("button"));
    document.removeEventListener("mousedown", onMouseDown);
    expect(onMouseDown).not.toHaveBeenCalled();
  });
});

describe("unsettled mark", () => {
  // Regression: a field whose query failed used to render no mark at all, and
  // a pending one mounted its glyph late, pushing the row's content around.
  it.each([
    [{ pending: true }, "Checking suggestion…"],
    [
      { error: new Error("upstream 503") },
      "Suggestion unavailable: upstream 503",
    ],
    [
      { pending: true, error: new Error("upstream 503") },
      "Suggestion unavailable: upstream 503",
    ],
  ])("%o shows %s before any outcome", (state, label) => {
    render(<SuggestionOutcomeMark outcome={null} {...state} />);
    expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
  });

  it("renders nothing when neither pending nor failed", () => {
    const { container } = render(<SuggestionOutcomeMark outcome={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
