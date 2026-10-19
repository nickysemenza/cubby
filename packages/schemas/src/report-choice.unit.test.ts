import { describe, expect, it } from "vitest";

import type { CommitPreparedRequest, ReportChoice } from "./entity-report";
import { shortcode } from "./identifiers";
import {
  type ChoiceAnswer,
  commitPreparedInput,
  distinctFromSourceFeedback,
  isChoiceAnswered,
  remainingChoices,
  remainingSentence,
} from "./report-choice";

// Failure modes: an existing-Product decision with no Product, or an unresolved decision with a
// blank reason, counted as answered; a trade left out of the commit that needs one; a reviewed
// line dropped or sent under another line's ids; an answer for a choice the batch never asked.
const decisionChoice = (id: string): ReportChoice => ({
  id,
  label: `Product decision for ${id}`,
  required: true,
  options: [
    {
      id: "existing",
      label: "Use an existing Product",
      pick: { entity: "product", label: "Product" },
    },
    { id: "new", label: "Create a new Product" },
    {
      id: "unresolved",
      label: "Leave Product unresolved",
      text: { label: "Reason" },
    },
  ],
});
const tradeChoice: ReportChoice = {
  id: "trade",
  label: "Trade for imported expenses",
  required: true,
  options: [
    { id: "other", label: "Other" },
    { id: "plumbing", label: "Plumbing" },
  ],
};

describe("isChoiceAnswered", () => {
  const choice = decisionChoice("o1/l1");
  it.each([
    [undefined, false],
    [{ optionId: "missing" }, false],
    [{ optionId: "existing" }, false],
    [{ optionId: "existing", pickId: "  " }, false],
    [{ optionId: "existing", pickId: "PRD-4K7M" }, true],
    [{ optionId: "new" }, true],
    [{ optionId: "unresolved" }, false],
    [{ optionId: "unresolved", text: "   " }, false],
    [{ optionId: "unresolved", text: "Cannot tell which" }, true],
  ])("%j is answered: %s", (answer, expected) => {
    expect(isChoiceAnswered(choice, answer)).toBe(expected);
  });
});

describe("remainingChoices", () => {
  it("counts only required choices without a complete answer", () => {
    const choices = [decisionChoice("a"), decisionChoice("b"), tradeChoice];
    expect(remainingChoices(choices, {})).toBe(3);
    expect(
      remainingChoices(choices, {
        a: { optionId: "new" },
        b: { optionId: "existing" },
        trade: { optionId: "other" },
      }),
    ).toBe(1);
  });

  it("ignores an optional choice", () => {
    expect(
      remainingChoices([{ ...decisionChoice("a"), required: false }], {}),
    ).toBe(0);
  });
});

describe("remainingSentence", () => {
  it("words the count the way the page always has", () => {
    expect(remainingSentence("Product decision", 1)).toBe(
      "1 Product decision remaining.",
    );
    expect(remainingSentence("Product decision", 2)).toBe(
      "2 Product decisions remaining.",
    );
  });
});

describe("commitPreparedInput", () => {
  const request: CommitPreparedRequest = {
    kind: "commit-prepared",
    runId: shortcode("RUN-4K7M"),
    prepareOperationId: "prepare-1",
    tradeChoiceId: "trade",
    lines: [
      { choiceId: "o1/l1", stableOrderId: "o1", stableLineId: "l1" },
      { choiceId: "o2/l1", stableOrderId: "o2", stableLineId: "l1" },
      { choiceId: "o2/l2", stableOrderId: "o2", stableLineId: "l2" },
    ],
  };
  const answers = {
    "o1/l1": { optionId: "existing", pickId: "PRD-4K7M" },
    "o2/l1": { optionId: "new" },
    "o2/l2": { optionId: "unresolved", text: "  Cannot tell which  " },
    trade: { optionId: "plumbing" },
  };

  it("sends each line's decision under its own order and line, with the trade and operation id", () => {
    expect(commitPreparedInput(request, answers, "op-1")).toEqual({
      runId: shortcode("RUN-4K7M"),
      operationId: "op-1",
      prepareOperationId: "prepare-1",
      defaultTrade: "plumbing",
      resolutions: [
        {
          stableOrderId: "o1",
          stableLineId: "l1",
          resolution: { kind: "existing", productId: "PRD-4K7M" },
        },
        {
          stableOrderId: "o2",
          stableLineId: "l1",
          resolution: { kind: "new" },
        },
        {
          stableOrderId: "o2",
          stableLineId: "l2",
          resolution: { kind: "unresolved", reason: "Cannot tell which" },
        },
      ],
    });
  });

  it("sends nothing while a decision or the trade is missing", () => {
    expect(
      commitPreparedInput(request, { ...answers, "o2/l1": undefined }, "op-1"),
    ).toBeNull();
    expect(
      commitPreparedInput(request, { ...answers, trade: undefined }, "op-1"),
    ).toBeNull();
    expect(
      commitPreparedInput(
        request,
        { ...answers, "o1/l1": { optionId: "existing", pickId: "not-a-code" } },
        "op-1",
      ),
    ).toBeNull();
  });

  it("omits the trade when the batch needs none", () => {
    const input = commitPreparedInput(
      { ...request, tradeChoiceId: null, lines: [] },
      {},
      "op-1",
    );
    expect(input).toEqual({
      runId: shortcode("RUN-4K7M"),
      operationId: "op-1",
      prepareOperationId: "prepare-1",
      resolutions: [],
    });
  });
});

// Failure modes (CubbyKit's `ReportChoiceAnswersTests` has the same cases): a new Product beside a
// listed candidate counted as answered without its Source; a Source or reason outside the commit's
// bounds sent anyway; feedback worded differently from native.
describe("Distinct-from Sources", () => {
  const choice: ReportChoice = {
    ...decisionChoice("o1/l1"),
    options: decisionChoice("o1/l1").options.map((option) =>
      option.id === "new"
        ? {
            ...option,
            distinctFrom: [
              { entity: "product", id: "PRD-7Q2W", name: "Same-named" },
            ],
          }
        : option,
    ),
  };
  const request: CommitPreparedRequest = {
    kind: "commit-prepared",
    runId: shortcode("RUN-4K7M"),
    prepareOperationId: "prepare-1",
    tradeChoiceId: null,
    lines: [{ choiceId: "o1/l1", stableOrderId: "o1", stableLineId: "l1" }],
  };
  const source = (url: string, quote: string) => ({
    optionId: "new",
    distinctFrom: { "PRD-7Q2W": { url, quote } },
  });

  it("needs a Source for each listed candidate before the choice is answered", () => {
    expect(isChoiceAnswered(choice, { optionId: "new" })).toBe(false);
    expect(
      isChoiceAnswered(choice, source("https://example.com/a", "  ")),
    ).toBe(false);
    expect(
      isChoiceAnswered(choice, source("https://example.com/a", "Family size")),
    ).toBe(true);
  });

  it("sends the trimmed Source, and nothing outside the commit's bounds", () => {
    const send = (answer: ChoiceAnswer) =>
      commitPreparedInput(request, { "o1/l1": answer }, "op-1");
    expect(
      send(source(" https://example.com/a ", " Family size "))?.resolutions[0]
        ?.resolution,
    ).toEqual({
      kind: "new",
      distinctFrom: [
        {
          productId: "PRD-7Q2W",
          url: "https://example.com/a",
          quote: "Family size",
        },
      ],
    });
    expect(send(source("https://", "Family size"))).toBeNull();
    expect(send(source("https://example.com/a", "q".repeat(2001)))).toBeNull();
    expect(send({ optionId: "unresolved", text: "r".repeat(1001) })).toBeNull();
  });

  it("words each field's problem", () => {
    expect(
      distinctFromSourceFeedback({
        url: "https://example.com/a",
        quote: " Family size ",
      }),
    ).toEqual({
      url: null,
      quote: null,
      quoteLength: "11 of 2,000 characters.",
    });
    expect(distinctFromSourceFeedback({ url: "  ", quote: "" }).url).toBeNull();
    expect(
      distinctFromSourceFeedback({ url: "https://", quote: "q".repeat(2001) }),
    ).toEqual({
      url: "Enter a full URL of at most 2,048 characters.",
      quote: "Shorten the quote to at most 2,000 characters.",
      quoteLength: "2,001 of 2,000 characters.",
    });
  });
});
