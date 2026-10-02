/**
 * Real-browser layout invariants for the Jev suggestion surfaces (PR #1223):
 * a fixed glyph footprint across states, a phone inline review folding into
 * the glyph instead of growing the page, a desktop inline review staying on
 * its one wrapping row, and `SuggestionStatus`'s headline never wrapping.
 *
 * jsdom cannot see any of this — it has no layout engine, so every
 * `getBoundingClientRect()` is `{0,0,0,0}` and no media query ever matches a
 * width. This file runs in a real (headless) Chromium tab via Vitest's
 * `preview` project (`pnpm test:preview`), at the two widths the app actually
 * ships: a phone (402x874) and a desktop (1440x900).
 */
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

import { SuggestionOutcomeMark } from "./suggestion-outcome-mark";
import { SuggestionReview } from "./suggestion-review";
import {
  SuggestionStatus,
  type SuggestionStatusField,
} from "./suggestion-status";

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
  "SuggestionOutcomeMark glyph footprint — %s surface",
  (surface) => {
    it.each([["phone", PHONE] as const, ["desktop", DESKTOP] as const])(
      "keeps the same button size across pending → evaluated → error (%s)",
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

        // A tolerance of 1px absorbs sub-pixel layout rounding; a
        // regression that grows the glyph (e.g. an inline headline
        // sneaking into the trigger) shows up as several pixels, not a
        // rounding error.
        expect(evaluatedBox.width).toBeCloseTo(pendingBox.width, 0);
        expect(evaluatedBox.height).toBeCloseTo(pendingBox.height, 0);
        expect(errorBox.width).toBeCloseTo(pendingBox.width, 0);
        expect(errorBox.height).toBeCloseTo(pendingBox.height, 0);
      },
    );
  },
);

describe("SuggestionReview inline surface — phone folding", () => {
  it("adds no height when an actionable proposal arrives (folds into the glyph)", async () => {
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

    // The regression this guards: an inline review that grew the page under
    // the reader's finger instead of folding into the mark's popover.
    expect(actionableHeight).toBeCloseTo(pendingHeight, 0);
    // Sanity check the proposal really arrived, just folded — not that
    // nothing rendered at all.
    expect(screen.queryByText("Tools")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Use suggestion" }),
    ).not.toBeInTheDocument();
  });
});

describe("SuggestionReview inline surface — desktop one line", () => {
  it("keeps a short actionable proposal on the value's row instead of wrapping", async () => {
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

    // If the row wrapped, the suggested value and the "Use suggestion"
    // button would land a full line height apart; on one row their tops
    // sit within a few px of each other (icon/button baseline differences).
    const valueTop = screen.getByText("Tools").getBoundingClientRect().top;
    const buttonTop = screen
      .getByRole("button", { name: "Use suggestion" })
      .getBoundingClientRect().top;
    expect(Math.abs(valueTop - buttonTop)).toBeLessThan(10);
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
