/** Real-browser suggestion contracts: named status controls, phone touch
 * targets, visible inline review without overflow, and compact desktop values.
 * jsdom cannot establish geometry; this file runs in Chromium. */
import type {
  FieldSuggestion,
  FieldSuggestionOutcome,
} from "@cubby/schemas/ai";
import {
  fieldSuggestionOutcomeSchema,
  fieldSuggestionSchema,
} from "@cubby/schemas/ai";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { page } from "vitest/browser";

import { mock } from "~/lib/test/mock-schema";

import { SuggestionOutcomeMark } from "../../entity/suggestions/suggestion-outcome-mark";
import { SuggestionReview } from "../../entity/suggestions/suggestion-review";
import {
  SuggestionStatus,
  type SuggestionStatusField,
} from "../../entity/suggestions/suggestion-status";

const PHONE = { width: 402, height: 874 } as const;
const DESKTOP = { width: 1440, height: 900 } as const;

/** An actionable `set` proposal — probability clears both review thresholds
 * (FILL_THRESHOLD and ALTERNATIVE_THRESHOLD) against a filled current value,
 * and its value/label are short enough to plausibly fit one row. */
function actionableSuggestionFixture(): FieldSuggestion {
  return mock(fieldSuggestionSchema, {
    seed: 1,
    overrides: {
      value: "tools",
      label: "Tools",
      detail: null,
      confidence: "high",
      probability: 0.97,
      reasoning: "",
      alternatives: [],
      operation: "set",
      removals: [],
    },
  });
}

function declinedOutcomeFixture(): FieldSuggestionOutcome {
  return mock(fieldSuggestionOutcomeSchema, {
    seed: 2,
    overrides: {
      kind: "evaluated",
      answer: "none",
      confidence: "high",
      probability: 0.4,
      alternatives: [],
    },
  });
}

function skippedFieldFixture(): SuggestionStatusField {
  return {
    label: "Category",
    outcome: mock(fieldSuggestionOutcomeSchema, {
      seed: 3,
      overrides: { kind: "skipped", reason: "no_signal" },
    }),
    suggestion: null,
    currentValue: null,
  };
}

describe.each(["inline", "cell"] as const)(
  "SuggestionOutcomeMark accessible status — %s surface",
  (surface) => {
    it.each([["phone", PHONE] as const, ["desktop", DESKTOP] as const])(
      "keeps pending, evaluated and error controls labelled and touchable (%s)",
      async (_label, { width, height }) => {
        await page.viewport(width, height);
        const { container, rerender } = render(
          <SuggestionOutcomeMark surface={surface} pending />,
        );
        const box = () =>
          container.querySelector("button")!.getBoundingClientRect();
        const pendingBox = box();
        expect(pendingBox.width).toBeGreaterThan(0);

        rerender(
          <SuggestionOutcomeMark
            surface={surface}
            outcome={declinedOutcomeFixture()}
          />,
        );
        const evaluatedBox = box();

        rerender(
          <SuggestionOutcomeMark surface={surface} error={new Error("boom")} />,
        );
        const errorBox = box();

        // Status text may change width; its action must remain named and usable.
        for (const state of [pendingBox, evaluatedBox, errorBox]) {
          expect(state.width).toBeGreaterThan(0);
          expect(state.height).toBeGreaterThanOrEqual(
            width === PHONE.width && surface === "inline" ? 44 : 1,
          );
        }
        expect(container.querySelector("button")).toHaveAccessibleName();
      },
    );
  },
);

describe("SuggestionReview inline surface — phone review", () => {
  it("shows an actionable proposal without horizontal overflow", async () => {
    await page.viewport(PHONE.width, PHONE.height);
    const suggestion = actionableSuggestionFixture();

    const { container, rerender } = render(
      <SuggestionReview
        suggestion={null}
        currentValue="materials"
        currentLabel="Materials"
        questionKey="phone-fold"
        onApply={() => {}}
        surface="inline"
        pending
      >
        <span>Materials</span>
      </SuggestionReview>,
    );
    const pendingHeight = container.getBoundingClientRect().height;
    expect(pendingHeight).toBeGreaterThan(0);

    rerender(
      <SuggestionReview
        suggestion={suggestion}
        currentValue="materials"
        currentLabel="Materials"
        questionKey="phone-fold"
        onApply={() => {}}
        surface="inline"
      >
        <span>Materials</span>
      </SuggestionReview>,
    );
    const actionableHeight = container.getBoundingClientRect().height;

    expect(actionableHeight).toBeGreaterThanOrEqual(pendingHeight);
    expect(screen.getByText("Tools")).toBeVisible();
    expect(
      screen
        .getByRole("button", { name: "Accept", exact: true })
        .getBoundingClientRect().height,
    ).toBeGreaterThanOrEqual(44);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
      window.innerWidth,
    );
  });
});

describe("SuggestionReview inline surface — desktop one line", () => {
  it("keeps a short proposal and its confidence on one row instead of wrapping", async () => {
    await page.viewport(DESKTOP.width, DESKTOP.height);
    const suggestion = actionableSuggestionFixture();

    render(
      <SuggestionReview
        suggestion={suggestion}
        currentValue="materials"
        currentLabel="Materials"
        questionKey="desktop-one-line"
        onApply={() => {}}
        surface="inline"
      >
        <span>Materials</span>
      </SuggestionReview>,
    );

    // If the proposal row wrapped, the suggested value and its confidence
    // would land a full line height apart; on one row their tops sit within
    // a few px of each other.
    const valueTop = screen.getByText("Tools").getBoundingClientRect().top;
    const confidenceTop = screen
      .getByText("Confidence: 97% · high")
      .getBoundingClientRect().top;
    expect(Math.abs(valueTop - confidenceTop)).toBeLessThan(10);
  });
});

describe("SuggestionStatus headline", () => {
  it("renders the settled long headline at the same height as the checking headline at phone width", async () => {
    await page.viewport(PHONE.width, PHONE.height);

    const { container, rerender } = render(
      <SuggestionStatus checking failures={0} count={0} fields={[]} />,
    );
    expect(screen.getByText("Checking suggestions…")).toBeInTheDocument();
    const checkingHeight = container.getBoundingClientRect().height;
    expect(checkingHeight).toBeGreaterThan(0);

    rerender(
      <SuggestionStatus
        checking={false}
        failures={1}
        count={0}
        fields={[skippedFieldFixture()]}
      />,
    );
    // Pins the exact copy this test measures, so a wording change is a
    // visible diff here rather than a silent height assertion.
    expect(
      screen.getByText(
        "No suggestions · 0 fields checked · 1 not checked · Some suggestions unavailable",
      ),
    ).toBeInTheDocument();
    const settledHeight = container.getBoundingClientRect().height;

    // The regression this guards: a long per-field summary wrapping to a
    // second line and growing the row it sits in on a phone-width page.
    expect(settledHeight).toBeCloseTo(checkingHeight, 0);
  });
});
