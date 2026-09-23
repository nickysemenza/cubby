import type {
  FieldSuggestion,
  FieldSuggestionOutcome,
} from "@cubby/schemas/ai";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  SuggestionStatus,
  type SuggestionStatusField,
} from "./suggestion-status";

const pick = (probability: number): FieldSuggestionOutcome => ({
  kind: "evaluated",
  answer: "pick",
  confidence: "high",
  probability,
  alternatives: [],
});

const skipped = (
  reason: "no_signal" | "no_candidates" | "resolved",
): FieldSuggestionOutcome => ({ kind: "skipped", reason });

function suggestion(value: string, probability: number): FieldSuggestion {
  return {
    value,
    label: value,
    detail: null,
    confidence: "high",
    probability,
    reasoning: "",
    alternatives: [],
    operation: "set",
    removals: [],
  };
}

describe("SuggestionStatus copy", () => {
  it("renders nothing when there is nothing to report", () => {
    const { container } = render(
      <SuggestionStatus checking={false} failures={0} count={0} fields={[]} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  // Regression: a failed check left nothing to report, so the focused
  // "Checking suggestions…" trigger unmounted and the bulk-edit dialog
  // refocused its own shell mid-interaction.
  it("keeps the status trigger mounted when a check fails outright", () => {
    const { rerender } = render(
      <SuggestionStatus checking failures={0} count={0} fields={[]} />,
    );
    const trigger = screen.getByRole("button", {
      name: /Checking suggestions/,
    });
    rerender(
      <SuggestionStatus checking={false} failures={1} count={0} fields={[]} />,
    );
    expect(trigger).toBeInTheDocument();
    expect(trigger).toHaveTextContent("Suggestions unavailable");
  });

  it("shows 'Checking suggestions…' while a request is in flight", () => {
    render(<SuggestionStatus checking failures={0} count={0} fields={[]} />);
    expect(screen.getByText("Checking suggestions…")).toBeInTheDocument();
  });

  it("shows the unasked reason before any request went out", () => {
    render(
      <SuggestionStatus
        checking={false}
        failures={0}
        count={0}
        fields={[]}
        unasked="name"
      />,
    );
    expect(
      screen.getByText("Not checked — add a name first"),
    ).toBeInTheDocument();
  });

  it("pluralizes zero, one, and many suggestions", () => {
    const fields: SuggestionStatusField[] = [
      {
        label: "Category",
        outcome: pick(0.9),
        suggestion: null,
        currentValue: null,
      },
    ];
    const { rerender } = render(
      <SuggestionStatus
        checking={false}
        failures={0}
        count={0}
        fields={fields}
      />,
    );
    expect(
      screen.getByText("No suggestions · 1 field checked"),
    ).toBeInTheDocument();

    rerender(
      <SuggestionStatus
        checking={false}
        failures={0}
        count={1}
        fields={fields}
      />,
    );
    expect(
      screen.getByText("1 suggestion · 1 field checked"),
    ).toBeInTheDocument();

    const twoFields: SuggestionStatusField[] = [
      ...fields,
      {
        label: "Location",
        outcome: pick(0.9),
        suggestion: null,
        currentValue: null,
      },
    ];
    rerender(
      <SuggestionStatus
        checking={false}
        failures={0}
        count={2}
        fields={twoFields}
      />,
    );
    expect(
      screen.getByText("2 suggestions · 2 fields checked"),
    ).toBeInTheDocument();
  });

  it("reports skipped fields and failures alongside the checked count", () => {
    const fields: SuggestionStatusField[] = [
      {
        label: "Category",
        outcome: pick(0.9),
        suggestion: null,
        currentValue: null,
      },
      {
        label: "Location",
        outcome: skipped("no_candidates"),
        suggestion: null,
        currentValue: null,
      },
    ];
    render(
      <SuggestionStatus
        checking={false}
        failures={1}
        count={0}
        fields={fields}
      />,
    );
    expect(
      screen.getByText(
        "No suggestions · 1 field checked · 1 not checked · Some suggestions unavailable",
      ),
    ).toBeInTheDocument();
  });

  it("lists each field's outcome in the popover at or below the listing cap", () => {
    const materials = suggestion("materials", 0.91);
    const fields: SuggestionStatusField[] = [
      {
        label: "Category",
        outcome: pick(0.91),
        suggestion: materials,
        currentValue: "materials",
        currentLabel: "Materials",
      },
      {
        label: "Location",
        outcome: skipped("no_candidates"),
        suggestion: null,
        currentValue: null,
      },
    ];
    render(
      <SuggestionStatus
        checking={false}
        failures={0}
        count={0}
        fields={fields}
      />,
    );
    openPopover();
    expect(
      screen.getByText("Category — Agrees with Materials · 91%"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Location — Not checked — no candidates"),
    ).toBeInTheDocument();
  });

  it("aggregates into buckets once the field list exceeds the listing cap", () => {
    const fields: SuggestionStatusField[] = Array.from(
      { length: 9 },
      (_, index) => ({
        label: `Field ${index}`,
        outcome: index < 3 ? skipped("no_signal") : pick(0.9),
        suggestion:
          index >= 3 && index < 6 ? suggestion(`v${index}`, 0.9) : null,
        currentValue: index >= 3 && index < 6 ? `v${index}` : null,
      }),
    );
    render(
      <SuggestionStatus
        checking={false}
        failures={0}
        count={0}
        fields={fields}
      />,
    );
    openPopover();
    // 3 skipped, 3 agree (suggestion === currentValue), 3 would-change (no suggestion, answer pick but no match).
    expect(
      screen.getByText("3 agree · 3 would change · 3 not checked"),
    ).toBeInTheDocument();
  });
});

function openPopover() {
  fireEvent.click(screen.getByRole("button"));
}
