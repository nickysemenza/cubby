import {
  automaticRuleOut,
  type AutomaticRuleOut,
} from "@cubby/schemas/automatic-rule";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { suggestions } from "~/integrations/tanstack-query/generated/catalog.gen";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import {
  AutomaticRulesSection,
  type AutomaticRuleOperations,
} from "./automatic-rules";

const rule = (patch: Partial<AutomaticRuleOut>): AutomaticRuleOut =>
  automaticRuleOut.parse({
    family: "field",
    ruleKey: "field.addition",
    revision: "2026-10-01.1",
    description: "A synthetic rule description.",
    enabled: false,
    enabledRevision: "2026-10-01.1",
    enabledAt: null,
    enabledByUserId: null,
    enabledReason: null,
    disabledAt: null,
    disabledReason: null,
    eligible: false,
    n: 0,
    hits: 0,
    precision: null,
    correctedAutomatic: 0,
    windows: [],
    ...patch,
  });

const FIELD_ON = rule({
  enabled: true,
  enabledAt: "2026-10-02T12:00:00.000Z",
  n: 140,
  hits: 138,
  precision: 138 / 140,
  correctedAutomatic: 2,
  eligible: true,
});
const ATTACH_OFF = rule({
  family: "statement_transaction",
  ruleKey: "statement_transaction.attach",
  revision: "v1/p1",
  n: 12,
  hits: 12,
  precision: 1,
  disabledReason: "Turned itself off: synthetic window n=50, hits=48",
});

let harness: ReturnType<typeof createBrowserTestHarness>;
beforeEach(() => {
  harness = createBrowserTestHarness();
});
afterEach(() => {
  harness.dispose();
});

function operations(
  rules: AutomaticRuleOut[],
  setRule: (input: {
    ruleKey: string;
    enabled: boolean;
  }) => Promise<AutomaticRuleOut>,
): AutomaticRuleOperations {
  return {
    rules: suggestions.rules.withTransport(async () => ({ rules })),
    setRule: suggestions.setRule.withTransport(({ input }) => setRule(input)),
  };
}

const row = (name: string) => screen.getByRole("listitem", { name });

describe("AutomaticRulesSection", () => {
  // Failure modes: a not-yet-eligible rule offers On; the numbers or the raw
  // disabled reason go missing.
  it("offers On only to an eligible rule and shows its measured numbers", async () => {
    render(
      <AutomaticRulesSection
        operations={operations([FIELD_ON, ATTACH_OFF], async () => FIELD_ON)}
      />,
      { wrapper: harness.wrapper },
    );
    await screen.findByRole("listitem", { name: "Field Addition" });
    const field = row("Field Addition");
    expect(field).toHaveTextContent(
      "98.5% precision over 140 reviewed · 2 corrected automatic",
    );
    expect(within(field).getByText("On")).toBeVisible();
    expect(
      within(field).getByRole("switch", {
        name: "Field Addition automatic rule",
      }),
    ).not.toHaveAttribute("aria-disabled", "true");

    const attach = row("Statement attach");
    expect(within(attach).getByText("Not yet eligible")).toBeVisible();
    expect(
      within(attach).getByRole("switch", {
        name: "Statement attach automatic rule",
      }),
    ).toHaveAttribute("aria-disabled", "true");
    expect(attach).toHaveTextContent(
      "Turned itself off: synthetic window n=50, hits=48",
    );
    expect(screen.getByText("1 of 2 on")).toBeVisible();
  });

  // Failure mode: the server's refusal is swallowed or softened.
  it("shows the server's raw refusal when turning an eligible rule on", async () => {
    const refusal =
      "CONSTRAINT_VIOLATION: statement_transaction.attach@v1/p1 is not eligible: n=49, hits=49";
    const calls: unknown[] = [];
    render(
      <AutomaticRulesSection
        operations={operations(
          [{ ...ATTACH_OFF, eligible: true }],
          async (input) => {
            calls.push(input);
            throw new Error(refusal);
          },
        )}
      />,
      { wrapper: harness.wrapper },
    );
    const toggle = await screen.findByRole("switch", {
      name: "Statement attach automatic rule",
    });
    expect(toggle).not.toHaveAttribute("aria-disabled", "true");
    fireEvent.click(toggle);
    expect(await screen.findByRole("alert")).toHaveTextContent(refusal);
    expect(calls).toEqual([
      { ruleKey: "statement_transaction.attach", enabled: true },
    ]);
  });

  // Failure mode: Off writes without the member confirming.
  it("confirms before turning a rule off", async () => {
    const calls: unknown[] = [];
    render(
      <AutomaticRulesSection
        operations={operations([FIELD_ON], async (input) => {
          calls.push(input);
          return { ...FIELD_ON, enabled: false };
        })}
      />,
      { wrapper: harness.wrapper },
    );
    fireEvent.click(
      await screen.findByRole("switch", {
        name: "Field Addition automatic rule",
      }),
    );
    expect(calls).toEqual([]);
    fireEvent.click(await screen.findByRole("button", { name: "Turn off" }));
    await waitFor(() =>
      expect(calls).toEqual([{ ruleKey: "field.addition", enabled: false }]),
    );
  });
});
