import {
  unsafeExpenseShortcode,
  unsafeProjectShortcode,
  unsafePurchaseShortcode,
} from "@cubby/schemas/identifiers";
import { expenseOut } from "@cubby/schemas/project";
import { purchaseOut } from "@cubby/schemas/purchase";
import { describe, expect, it } from "vitest";
import { mock } from "~/lib/test/mock-schema";
import {
  buildProjectPurchaseRows,
  projectPurchaseSubRows,
} from "./project-purchase-rows";

const THIS_PROJECT = unsafeProjectShortcode("PRJ-AAAA");
const OTHER_PROJECT = unsafeProjectShortcode("PRJ-BBBB");

const purchase = (shortcode: string, expenseCount: number) =>
  mock(purchaseOut, {
    seed: 1,
    overrides: {
      id: unsafePurchaseShortcode(shortcode),
      orderId: `order-${shortcode}`,
      displayLabel: null,
      date: "2026-01-05",
      expenseCount,
    },
  });

const expense = (
  shortcode: string,
  purchaseId: string | null,
  projectId: string | null,
  cost: number,
) =>
  mock(expenseOut, {
    seed: 2,
    overrides: {
      id: unsafeExpenseShortcode(shortcode),
      name: `Line ${shortcode}`,
      purchaseId:
        purchaseId === null ? null : unsafePurchaseShortcode(purchaseId),
      projectId: projectId === null ? null : unsafeProjectShortcode(projectId),
      date: "2026-01-05",
      cost,
    },
  });

describe("buildProjectPurchaseRows", () => {
  it("nests only the lines charged to this project, and sums just those", () => {
    // The purchase has three lines; one landed on another project entirely, so
    // neither the sub-rows nor `projectSpend` may count it.
    const rows = buildProjectPurchaseRows(
      [purchase("PUR-0001", 3)],
      [
        expense("EXP-0001", "PUR-0001", THIS_PROJECT, 10),
        expense("EXP-0002", "PUR-0001", THIS_PROJECT, 5),
        expense("EXP-0003", "PUR-0001", OTHER_PROJECT, 100),
      ],
      THIS_PROJECT,
    );

    const row = rows[0]!;
    expect(row.kind).toBe("purchase");
    if (row.kind !== "purchase") return;
    expect(row.linesOnProject).toBe(2);
    expect(row.projectSpend).toBe(15);
    expect(projectPurchaseSubRows(row)?.map((child) => child.name)).toEqual([
      "Line EXP-0001",
      "Line EXP-0002",
    ]);
  });

  it("carries the counts the 'N of M lines' disclosure is derived from", () => {
    // linesOnProject < expenseCount is what tells the reader that the charge
    // they're looking at is only partly theirs.
    const shared = buildProjectPurchaseRows(
      [purchase("PUR-0002", 9)],
      [expense("EXP-0004", "PUR-0002", THIS_PROJECT, 20)],
      THIS_PROJECT,
    )[0]!;
    expect(
      shared.kind === "purchase" &&
        shared.linesOnProject < shared.purchase.expenseCount,
    ).toBe(true);

    const whole = buildProjectPurchaseRows(
      [purchase("PUR-0003", 1)],
      [expense("EXP-0005", "PUR-0003", THIS_PROJECT, 20)],
      THIS_PROJECT,
    )[0]!;
    expect(
      whole.kind === "purchase" &&
        whole.linesOnProject === whole.purchase.expenseCount,
    ).toBe(true);
  });

  it("gives a purchase with no lines here no sub-rows, so it renders no chevron", () => {
    // `getCanExpand()` is false without `subRows`, which keeps a chevron that
    // opens nothing off the row. Unassigned lines must not become children.
    const rows = buildProjectPurchaseRows(
      [purchase("PUR-0004", 2)],
      [
        expense("EXP-0006", "PUR-0004", null, 7),
        expense("EXP-0007", null, THIS_PROJECT, 7),
      ],
      THIS_PROJECT,
    );

    const row = rows[0]!;
    expect(projectPurchaseSubRows(row)).toBeUndefined();
    expect(row.kind === "purchase" && row.projectSpend).toBe(0);
  });

  it("namespaces child row ids by their parent purchase", () => {
    // `useEntityList` keys expansion and virtualizer measurements by `id`.
    const row = buildProjectPurchaseRows(
      [purchase("PUR-0005", 1)],
      [expense("EXP-0008", "PUR-0005", THIS_PROJECT, 3)],
      THIS_PROJECT,
    )[0]!;
    const child = projectPurchaseSubRows(row)?.[0];
    expect(child?.id).toBe("PUR-0005:EXP-0008");
    expect(child?.kind === "expense" && child.expenseId).toBe("EXP-0008");
  });

  it("flattens a date onto both row kinds so one date column serves the tree", () => {
    const row = buildProjectPurchaseRows(
      [purchase("PUR-0006", 1)],
      [expense("EXP-0009", "PUR-0006", THIS_PROJECT, 3)],
      THIS_PROJECT,
    )[0]!;
    expect(row.date).toBe("2026-01-05");
    expect(projectPurchaseSubRows(row)?.[0]?.date).toBe("2026-01-05");
  });

  it("returns undefined sub-rows for an expense row", () => {
    const row = buildProjectPurchaseRows(
      [purchase("PUR-0007", 1)],
      [expense("EXP-0010", "PUR-0007", THIS_PROJECT, 3)],
      THIS_PROJECT,
    )[0]!;
    const child = projectPurchaseSubRows(row)![0]!;
    expect(projectPurchaseSubRows(child)).toBeUndefined();
  });
});
