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
  it("labels confirmed member authority without inventing model confidence", () => {
    const outcome: FieldSuggestionOutcome = {
      kind: "correction",
      targetInputFingerprint: null,
      decision: {
        status: "confirmed",
        correctionKey: "synthetic-key",
        revision: "synthetic-revision",
        sourceFeedbackId: "00000000-0000-4000-8000-000000000001",
        sourceApplicationFeedbackId: "00000000-0000-4000-8000-000000000002",
        value: null,
      },
    };
    render(<SuggestionOutcomeMark outcome={outcome} surface="line" />);
    expect(screen.getByText(/Uses your correction/u)).toBeTruthy();
    expect(describeOutcome({ outcome })).not.toMatch(/%|confidence/u);
  });

  it("keeps conflicting corrections passive", () => {
    const outcome: FieldSuggestionOutcome = {
      kind: "correction",
      targetInputFingerprint: null,
      decision: {
        status: "conflict",
        correctionKey: "synthetic-key",
        revision: "synthetic-revision",
        sources: [
          {
            sourceFeedbackId: "00000000-0000-4000-8000-000000000001",
            sourceApplicationFeedbackId: "00000000-0000-4000-8000-000000000002",
            value: null,
          },
        ],
      },
    };
    expect(describeOutcome({ outcome })).toBe(
      "Conflicting corrections — held for review",
    );
  });
  it("agrees with the current value", () => {
    expect(
      describeOutcome({
        outcome: pickOutcome(),
        suggestion,
        currentValue: "materials",
        currentLabel: "Materials",
      }),
    ).toBe("Agrees with Materials · 91% · high");
  });

  it("reads 'Filled in' when auto-filled rather than 'Agrees with'", () => {
    expect(
      describeOutcome({
        outcome: pickOutcome(),
        suggestion,
        currentValue: "materials",
        autoFilled: true,
      }),
    ).toBe("Filled in · 91% · high");
  });

  it("reads 'Suggested' for an actionable pick", () => {
    expect(
      describeOutcome({
        outcome: pickOutcome(),
        suggestion,
        currentValue: null,
        actionable: true,
      }),
    ).toBe("Suggested Materials · 91% · high");
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
    ).toBe("Leaning Other · 64% · medium — needs 85%");
  });

  it("reads 'Would pick' with the alternative threshold when the field already has a value", () => {
    expect(
      describeOutcome({
        outcome: pickOutcome({ probability: 0.62 }),
        suggestion: { ...suggestion, probability: 0.62 },
        currentValue: "tools",
        actionable: false,
      }),
    ).toBe("Would pick Materials · 62% · medium — needs 95% to change");
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
    ).toBe("Would pick Materials · 62% · medium — needs 95% to change");
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
    ).toBe("No good fit · 78% · medium");
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
    ).toBe("Agrees with Materials · 94% · high");
  });

  it("says the bucket alone instead of a percent when probability is null (chat-tier roster overflow)", () => {
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
    ).toBe("Suggested Materials · high");
  });

  it("returns an empty string with no outcome", () => {
    expect(describeOutcome({ outcome: null })).toBe("");
  });
});

describe("SuggestionOutcomeMark", () => {
  it.each([false, true])(
    "keeps grid navigation keys available for pending=%s",
    (pending) => {
      const onKeyDown = vi.fn();
      document.addEventListener("keydown", onKeyDown);
      try {
        render(
          <SuggestionOutcomeMark
            surface="cell"
            pending={pending}
            outcome={pending ? null : { kind: "skipped", reason: "no_signal" }}
          />,
        );
        const trigger = screen.getByRole("button");
        fireEvent.keyDown(trigger, { key: "ArrowDown" });
        expect(onKeyDown).toHaveBeenCalledTimes(1);
        fireEvent.keyDown(trigger, { key: "Enter" });
        fireEvent.keyDown(trigger, { key: " " });
        expect(onKeyDown).toHaveBeenCalledTimes(1);
      } finally {
        document.removeEventListener("keydown", onKeyDown);
      }
    },
  );
  it.each<FieldSuggestionOutcome>([
    pickOutcome({ answer: "none", reviewStatus: "rejected" }),
    { kind: "skipped", reason: "no_signal", reviewStatus: "rejected" },
  ])(
    "preserves persisted rejection metadata on an empty field (%o)",
    (outcome) => {
      render(<SuggestionOutcomeMark surface="cell" outcome={outcome} />);
      const trigger = screen.getByRole("button", { name: /Rejected/ });
      expect(trigger).toHaveTextContent("Rejected");
      expect(trigger).not.toHaveAttribute("tabindex", "-1");
      fireEvent.click(trigger);
      expect(
        screen.queryByRole("button", { name: /Accept/ }),
      ).not.toBeInTheDocument();
    },
  );

  it("distinguishes a queued query from one actively checking", () => {
    render(<SuggestionOutcomeMark surface="cell" pending checking={false} />);
    expect(
      screen.getByRole("button", { name: /Suggestion pending/ }),
    ).toHaveTextContent("Pending");
    expect(
      screen.queryByRole("button", { name: /Checking suggestion/ }),
    ).not.toBeInTheDocument();
  });

  it("keeps an empty cell's settled outcome keyboard accessible", () => {
    render(
      <SuggestionOutcomeMark
        surface="cell"
        outcome={pickOutcome({ answer: "none" })}
      />,
    );
    const trigger = screen.getByRole("button", { name: /No good fit/ });
    expect(trigger).not.toHaveAttribute("tabindex", "-1");
    expect(trigger).toHaveTextContent("No good fit");
  });

  it("retains a dismissed empty-field explanation", () => {
    render(
      <SuggestionOutcomeMark
        surface="cell"
        suggestion={suggestion}
        actionable
        dismissed
      />,
    );
    expect(screen.getByRole("button", { name: /Dismissed/ })).toHaveTextContent(
      "Dismissed",
    );
  });

  it("does not imply an empty field was never evaluated without history", () => {
    render(<SuggestionOutcomeMark surface="cell" />);
    expect(
      screen.getByRole("button", { name: /Evaluation status unavailable/ }),
    ).toHaveTextContent("Status unknown");
  });

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
      screen.getByRole("button", { name: "Suggested Materials · 91% · high" }),
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
    expect(
      screen.getByText("Agrees with Materials · 91% · high"),
    ).toBeInTheDocument();
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

  it.each([
    ["neither pending nor failed", {}],
    // Regression: a form's never-enabled query reports isPending forever; its
    // glyph spun indefinitely and its hover popover swallowed the Create click.
    [
      "a form field (line surface) still pending",
      { pending: true, surface: "line" as const },
    ],
  ])("renders nothing for %s", (_, state) => {
    const { container } = render(
      <SuggestionOutcomeMark outcome={null} {...state} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
