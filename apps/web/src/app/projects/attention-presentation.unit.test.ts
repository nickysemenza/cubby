import {
  type ProjectAttentionItem,
  projectAttentionItemSchema,
} from "@cubby/schemas/project";
import { testShortcode } from "@cubby/schemas/testing";
import { describe, expect, it } from "vitest";
import { attentionEvidence } from "./attention-presentation";

/**
 * The card copy for every attention rule, pinned.
 *
 * This is the only place the wording is asserted, and it is worth asserting:
 * the whole point of the rewrite is that a card leads with the record's NAME
 * and follows with a LABELED measurement. The two failures being locked out
 * here are a bare unlabeled date (one grid puts a planned-expense date next to a
 * derived date-window bound) and a date without its year (these rows routinely
 * reach back several years).
 */
const item = <T extends ProjectAttentionItem["type"]>(
  type: T,
  facts: Extract<ProjectAttentionItem, { type: T }>["facts"],
): ProjectAttentionItem =>
  projectAttentionItemSchema.parse({
    key: `${type}:PRJ-0001`,
    type,
    severity: "info",
    name: "Placeholder",
    description: "",
    entityType: "project",
    entityId: testShortcode("project", "PRJ-0001"),
    date: null,
    amount: null,
    href: "/projects/PRJ-0001",
    facts,
  });

describe("attentionEvidence", () => {
  it.each([
    [
      "overdue_task",
      item("overdue_task", { due: "2026-06-04", daysOverdue: 78 }),
      "Due Jun 4, 2026 · 78 days overdue",
    ],
    [
      "blocked_work",
      item("blocked_work", { blockedTasks: 3 }),
      "3 blocked tasks · no unblocked next action",
    ],
    [
      "stalled_project",
      item("stalled_project", {
        lastActivity: "2022-06-04",
        daysSinceActivity: 1174,
        thresholdDays: 30,
      }),
      "Last activity Jun 4, 2022 · quiet for 1,174 days",
    ],
    [
      "past_due_planned_expense",
      item("past_due_planned_expense", {
        plannedFor: "2026-06-04",
        daysPastDue: 78,
        cost: 2400,
      }),
      "Planned for Jun 4, 2026 · 78 days past due · $2,400 not logged",
    ],
    [
      "missing_budget",
      item("missing_budget", {
        spend: 36291,
        actualSpend: 34120,
        committedSpend: 2171,
      }),
      "$36,291 in spend · no cost estimate",
    ],
    [
      "unclassified_expense",
      item("unclassified_expense", { date: "2026-06-04" }),
      "Dated Jun 4, 2026 · no trade, no cost",
    ],
    [
      "date_window_drift (start)",
      item("date_window_drift", {
        side: "start",
        override: "2022-06-05",
        derived: "2022-06-04",
        daysHidden: 1,
      }),
      "Start date Jun 5, 2022 hides work back to Jun 4, 2022 · 1 day",
    ],
    [
      "date_window_drift (end)",
      item("date_window_drift", {
        side: "end",
        override: "2022-06-05",
        derived: "2022-06-20",
        daysHidden: 15,
      }),
      "End date Jun 5, 2022 hides work through Jun 20, 2022 · 15 days",
    ],
  ])("%s", (_label, row, expected) => {
    expect(attentionEvidence(row)).toBe(expected);
  });

  it("drops the cost clause when a planned expense never carried one", () => {
    expect(
      attentionEvidence(
        item("past_due_planned_expense", {
          plannedFor: "2026-06-04",
          daysPastDue: 1,
          cost: null,
        }),
      ),
    ).toBe("Planned for Jun 4, 2026 · 1 day past due");
  });

  it("says so rather than showing nothing when an expense has no date", () => {
    expect(
      attentionEvidence(item("unclassified_expense", { date: null })),
    ).toBe("No date · no trade, no cost");
  });

  it("never emits a bare ISO date", () => {
    const evidence = attentionEvidence(
      item("date_window_drift", {
        side: "start",
        override: "2022-06-05",
        derived: "2022-06-04",
        daysHidden: 1,
      }),
    );
    expect(evidence).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});
