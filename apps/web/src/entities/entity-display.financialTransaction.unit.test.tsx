import type { CellData } from "@tanstack/react-table";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
  type CubbyColumnDef,
} from "~/app/_components/data-table/table-features";

import { createEntityDisplayColumns } from "./entity-display";

/**
 * The financial transaction list ("apps/web/src/app/finance/financial-transaction-list.tsx")
 * is the one page this file guards: every column it declares an override
 * for, and every generic column the declaration alone produces, must keep
 * exactly the shape asserted here. See `docs/entities.md`'s "declaration
 * wins" rule and the `14-financialTransaction.entity.ts` field roster.
 */

/** Row shape covering every financialTransaction field the list surfaces,
 * mirroring `FinancialTransactionOut` only where `createEntityDisplayColumns`
 * or the list's own overrides read it. */
interface FinancialTransactionRow {
  accountId: string;
  accountName: string | null;
  purchaseId: string | null;
  kind: string;
  status: string;
  amount: number;
  transactionDate: string | null;
  postedDate: string | null;
  merchant: string | null;
  rawDescription: string | null;
  sourceCategory: string | null;
  sourceRefs: { source: string; externalId: string }[];
  notes: string | null;
  vendorInference: { status: string } | null;
}

const TRANSACTION_ROW: FinancialTransactionRow = {
  accountId: "FAC-1",
  accountName: "Household checking",
  purchaseId: "PUR-1",
  kind: "purchase",
  status: "posted",
  amount: 42.5,
  transactionDate: "2026-09-10",
  postedDate: "2026-09-12",
  merchant: "Ace Hardware",
  rawDescription: "ACE HARDWARE #123",
  sourceCategory: "Home Improvement",
  sourceRefs: [{ source: "monarch", externalId: "abc123" }],
  notes: null,
  vendorInference: null,
};

/**
 * Narrows a column's `cell` to a callable renderer taking only `{ row }` —
 * every plain-scalar column `createEntityDisplayColumns` builds itself, and
 * the same shape every override here uses. Copied from the shared
 * `entity-display.unit.test.tsx` fixture rather than imported: it captures
 * `TValue` per call site (see `materializeCubbyColumns`'s doc in
 * table-features.ts), so it can't be hoisted to a shared helper module either.
 */
function isRowRenderer<TRecord extends object, TValue extends CellData>(
  cell: CubbyColumnDef<TRecord, TValue>["cell"],
): cell is (context: { row: { original: TRecord } }) => ReactNode {
  return typeof cell === "function";
}

function renderRowCell<TRecord extends object, TValue extends CellData>(
  cell: CubbyColumnDef<TRecord, TValue>["cell"],
  record: TRecord,
): ReactNode {
  if (!isRowRenderer<TRecord, TValue>(cell)) {
    throw new Error("Expected a row cell renderer.");
  }
  return cell({ row: { original: record } });
}

/**
 * Builds the financial transaction list's columns the same way
 * `financial-transaction-list.tsx` does: overrides for the eight columns
 * that render specially (`accountId`/`purchaseId` are `identifier` fields
 * with a `reference`, and `vendorInference`/`sourceRefs` are `json` fields —
 * `createEntityDisplayColumns` throws without an override for any of these;
 * `kind`/`status`/`amount`/`postedDate` keep their existing
 * select/currency/date renderers rather than falling back to the generic
 * one). Everything else (`transactionDate`, `merchant`, `rawDescription`,
 * `sourceCategory`, `notes`) is left generic to exercise the declaration's
 * own width/format/mobile metadata. The stubs below are test-local, not the
 * production renderers (which need router/query context) — same approach as
 * `entity-display.task.unit.test.tsx`.
 */
function buildFinancialTransactionColumns() {
  const helper = createCubbyColumnHelper<FinancialTransactionRow>();
  return createEntityDisplayColumns(
    "financialTransaction",
    helper,
    createCubbyColumnCollection<FinancialTransactionRow>((add) => {
      add(
        helper.display({
          id: "accountId",
          cell: ({ row }) => (
            <span>{row.original.accountName ?? row.original.accountId}</span>
          ),
        }),
      );
      add(
        helper.display({
          id: "kind",
          cell: ({ row }) => <span>{row.original.kind}</span>,
        }),
      );
      add(
        helper.display({
          id: "status",
          cell: ({ row }) => <span>{row.original.status}</span>,
        }),
      );
      add(
        helper.display({
          id: "amount",
          cell: ({ row }) => <span>{row.original.amount}</span>,
        }),
      );
      add(
        helper.display({
          id: "purchaseId",
          cell: ({ row }) => <span>{row.original.purchaseId ?? "—"}</span>,
        }),
      );
      add(
        helper.display({
          id: "postedDate",
          cell: ({ row }) => <span>{row.original.postedDate}</span>,
        }),
      );
      add(
        helper.display({
          id: "possibleVendor",
          enableSorting: false,
          cell: ({ row }) => (
            <span>{row.original.vendorInference ? "Vendor" : "—"}</span>
          ),
        }),
      );
      add(
        helper.display({
          id: "source",
          enableSorting: false,
          cell: ({ row }) => (
            <span>
              {row.original.sourceRefs.map((ref) => ref.source).join(", ")}
            </span>
          ),
        }),
      );
    }),
  );
}

/** Renders one column's cell against a fixture row — filtered to a single
 * column and invoked inside the same `.visit()` callback, so its `cell` is
 * used exactly where its `TValue` is still concrete (see
 * `materializeCubbyColumns`'s doc in table-features.ts). */
function renderTransactionCell(columnId: string, row: FinancialTransactionRow) {
  const columns = buildFinancialTransactionColumns();
  const matched = columns.filter((column) => column.id === columnId);
  const rendered = matched.visit((column) => renderRowCell(column.cell, row));
  const [first] = rendered;
  if (rendered.length !== 1 || first === undefined) {
    throw new Error(`Expected exactly one column with id ${columnId}.`);
  }
  return first;
}

function buildTransactionColumnMeta() {
  return buildFinancialTransactionColumns().visit((column) => ({
    id: String(
      column.id ?? ("accessorKey" in column ? column.accessorKey : ""),
    ),
    header: z.string().parse(column.header),
    className: column.meta?.className,
    mobile: column.meta?.mobile,
    enableSorting: column.enableSorting,
  }));
}

describe("financial transaction list display columns", () => {
  it("builds exactly the declared columns, in listOrder", () => {
    const ids = buildTransactionColumnMeta().map((d) => d.id);
    expect(ids).toEqual([
      "accountId",
      "kind",
      "status",
      "amount",
      "purchaseId",
      "transactionDate",
      "postedDate",
      "merchant",
      "possibleVendor",
      "source",
      "rawDescription",
      "sourceCategory",
      "notes",
    ]);
  });

  it("takes every header from the declared label, including on overrides", () => {
    const byId = Object.fromEntries(
      buildTransactionColumnMeta().map((d) => [d.id, d.header]),
    );
    expect(byId).toEqual({
      accountId: "Account",
      kind: "Kind",
      status: "Status",
      amount: "Amount",
      purchaseId: "Purchase",
      transactionDate: "Transaction Date",
      postedDate: "Posted",
      merchant: "Merchant",
      possibleVendor: "Possible vendor",
      source: "Source",
      rawDescription: "Statement description",
      sourceCategory: "Source category",
      notes: "Notes",
    });
  });

  it("derives enableSorting from the generated sort roster per column id", () => {
    const byId = Object.fromEntries(
      buildTransactionColumnMeta().map((d) => [d.id, d.enableSorting]),
    );
    // In `generatedEntitySort.financialTransaction.fields`.
    expect(byId.kind).toBe(true);
    expect(byId.status).toBe(true);
    expect(byId.amount).toBe(true);
    expect(byId.transactionDate).toBe(true);
    expect(byId.postedDate).toBe(true);
    expect(byId.merchant).toBe(true);
    // Not in the roster.
    expect(byId.accountId).toBe(false);
    expect(byId.purchaseId).toBe(false);
    expect(byId.possibleVendor).toBe(false);
    expect(byId.source).toBe(false);
    expect(byId.rawDescription).toBe(false);
    expect(byId.sourceCategory).toBe(false);
    expect(byId.notes).toBe(false);
  });

  it("carries the declared width/mobile metadata for generic columns", () => {
    const byId = Object.fromEntries(
      buildTransactionColumnMeta().map((d) => [d.id, d]),
    );
    expect(byId.transactionDate?.className).toBe("w-28");
    expect(byId.transactionDate?.mobile).toEqual({
      slot: "meta",
      priority: 25,
      interactive: undefined,
    });
    expect(byId.merchant?.className).toBe("w-40");
    expect(byId.merchant?.mobile).toBeUndefined();
    // `rawDescription`, `sourceCategory` and `notes` declare no width/mobile —
    // hidden by default in `financial-transaction-list.tsx`'s
    // `initialColumnVisibility`, but still built.
    expect(byId.rawDescription?.className).toBeUndefined();
    expect(byId.rawDescription?.mobile).toBeUndefined();
    expect(byId.sourceCategory?.className).toBeUndefined();
    expect(byId.sourceCategory?.mobile).toBeUndefined();
    expect(byId.notes?.className).toBeUndefined();
    expect(byId.notes?.mobile).toBeUndefined();
  });

  it.each([
    ["transactionDate", "Sep 10, 2026"],
    ["merchant", "Ace Hardware"],
  ] as const)(
    "renders the generic %s column from its declaration",
    (id, text) => {
      render(<>{renderTransactionCell(id, TRANSACTION_ROW)}</>);
      expect(screen.getByText(text)).toBeVisible();
    },
  );

  it("renders the accountId override's own cell against the row", () => {
    render(<>{renderTransactionCell("accountId", TRANSACTION_ROW)}</>);
    expect(screen.getByText("Household checking")).toBeVisible();
  });

  it("rejects an override for a field the declaration no longer lists (accountName is list: false)", () => {
    const helper = createCubbyColumnHelper<
      FinancialTransactionRow & { accountName: string }
    >();
    expect(() =>
      createEntityDisplayColumns(
        "financialTransaction",
        helper,
        createCubbyColumnCollection((add) => {
          add(helper.display({ id: "accountId", cell: () => null }));
          add(helper.display({ id: "kind", cell: () => null }));
          add(helper.display({ id: "status", cell: () => null }));
          add(helper.display({ id: "amount", cell: () => null }));
          add(helper.display({ id: "purchaseId", cell: () => null }));
          add(helper.display({ id: "postedDate", cell: () => null }));
          add(helper.display({ id: "possibleVendor", cell: () => null }));
          add(helper.display({ id: "source", cell: () => null }));
          add(helper.display({ id: "accountName", cell: () => null }));
        }),
      ),
    ).toThrow(
      "Undeclared display renderer for financialTransaction.accountName",
    );
  });
});
