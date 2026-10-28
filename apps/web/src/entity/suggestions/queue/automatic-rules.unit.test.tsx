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

import { createEditorBrowserTestHarness as createBrowserTestHarness } from "#web/tests/editor-metadata.fixtures.ts";
import { suggestions } from "~/integrations/tanstack-query/generated/catalog/suggestions.gen";

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
    ...patch,
  });

const FIELD_ON = rule({
  enabled: true,
  enabledAt: "2026-10-02T12:00:00.000Z",
  enabledReason: "Turned on by a member for field.addition@2026-10-01.1",
});
const ATTACH_OFF = rule({
  family: "statement_transaction",
  ruleKey: "statement_transaction.attach",
  revision: "v1/p1",
  disabledReason: "Turned off by a member",
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
  // Failure modes: an off rule cannot be turned on, or the switch reasons go
  // missing.
  it("offers both switches and shows each switch reason", async () => {
    render(
      <AutomaticRulesSection
        operations={operations([FIELD_ON, ATTACH_OFF], async () => FIELD_ON)}
      />,
      { wrapper: harness.wrapper },
    );
    await screen.findByRole("listitem", { name: "Field assignment" });
    const field = row("Field assignment");
    expect(within(field).getByText("On")).toBeVisible();
    expect(field).toHaveTextContent(
      "Turned on by a member for field.addition@2026-10-01.1",
    );
    const attach = row("Statement attach");
    expect(
      within(attach).getByRole("switch", {
        name: "Statement attach automatic rule",
      }),
    ).not.toHaveAttribute("aria-disabled", "true");
    expect(attach).toHaveTextContent("Turned off by a member");
    expect(screen.getByText("1 of 2 on")).toBeVisible();
  });

  // Failure mode: the server's refusal is swallowed or softened.
  it("shows the server's raw refusal when turning a rule on", async () => {
    const refusal =
      "CONSTRAINT_VIOLATION: Only a member turns an Automatic rule on or off";
    const calls: unknown[] = [];
    render(
      <AutomaticRulesSection
        operations={operations([ATTACH_OFF], async (input) => {
          calls.push(input);
          throw new Error(refusal);
        })}
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
        name: "Field assignment automatic rule",
      }),
    );
    expect(calls).toEqual([]);
    fireEvent.click(await screen.findByRole("button", { name: "Turn off" }));
    await waitFor(() =>
      expect(calls).toEqual([{ ruleKey: "field.addition", enabled: false }]),
    );
  });
});
