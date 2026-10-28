import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  createEditorTestQueryClient,
  renderWithEditorMetadata as render,
} from "#web/tests/editor-metadata.fixtures.ts";

import { KindVotes, kindAgreement } from "./statement-kind-votes";

const queryClient = createEditorTestQueryClient(["financialTransaction"]);

const create = (
  votes: Parameters<typeof kindAgreement>[1]["votes"],
  kind: "purchase" | "income" = "purchase",
) => ({
  kind,
  kindSource: "rule" as const,
  votes,
  counterparty: {
    label: "business" as const,
    history: null,
    storedValue: false,
  },
  status: "posted" as const,
  amount: -12.5,
  transactionDate: null,
  postedDate: null,
  merchant: "Synthetic Grocer",
  rawDescription: "SYNTHETIC GROCER 001",
  sourceCategory: null,
  notes: null,
});

describe("kindAgreement", () => {
  // Failure modes: the clean reason hides which sources agreed, a dissent
  // (including mixed history) reads as agreement, or votes-less legacy
  // judgments lose their kind source.
  it("names agreeing sources and each dissent", () => {
    expect(
      kindAgreement(
        queryClient,
        create({ rule: "purchase", label: null, history: "purchase" }),
      ).reason,
    ).toBe("2 of 3 agree: rule + history");
    expect(
      kindAgreement(
        queryClient,
        create({ rule: "purchase", label: "purchase", history: "mixed" }),
      ).reason,
    ).toBe("2 of 3 agree: rule + label; history says mixed");
    expect(
      kindAgreement(
        queryClient,
        create({ rule: null, label: null, history: null }),
      ),
    ).toMatchObject({ recorded: false, reason: "From the rule" });
  });
});

describe("KindVotes", () => {
  it("marks each source agreeing, disagreeing or abstaining", () => {
    render(
      <KindVotes
        create={create({ rule: "purchase", label: "income", history: null })}
      />,
    );
    const votes = within(screen.getByRole("list", { name: "Kind votes" }))
      .getAllByRole("listitem")
      .map((item) => [item.dataset.stance, item.textContent]);
    expect(votes).toEqual([
      ["agree", expect.stringContaining("Rule")],
      ["disagree", expect.stringContaining("Label")],
      ["abstain", expect.stringContaining("no vote")],
    ]);
    expect(screen.getByText(/1 of 3 agree: rule; label says/)).toBeVisible();
  });
});
