import type { CellData } from "@tanstack/react-table";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
  type CubbyColumnDef,
} from "~/ui/data-table/table-features";

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
 * `financial-transaction-list.tsx` does: overrides for the columns
 * that render specially (`accountId`/`purchaseId` are `identifier` fields
 * with a `reference`, and `sourceRefs` is a `json` field —
 * `createEntityDisplayColumns` throws without an override for any of these;
 * `amount`/`postedDate` keep their existing currency/date renderers rather
 * than falling back to the generic one). `vendorInference` comes from its
 * declared `possible-vendor` list renderer. Everything else (`kind`, `status`,
 * `transactionDate`, `merchant`, `rawDescription`, `sourceCategory`,
 * `notes`) is left generic to exercise the declaration's own
 * width/format/mobile metadata. The stubs below are test-local, not the
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
          id: "sourceRefs",
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

describe("financial transaction list display columns", () => {
  beforeEach(() =>
    vi.useFakeTimers({
      toFake: ["Date"],
      now: new Date("2026-10-05T19:00:00Z"),
    }),
  );
  afterEach(() => vi.useRealTimers());
  it.each([
    ["transactionDate", "Sep 10"],
    ["merchant", "Ace Hardware"],
  ] as const)(
    "renders the generic %s column from its declaration",
    (id, text) => {
      render(<>{renderTransactionCell(id, TRANSACTION_ROW)}</>);
      expect(screen.getByText(text)).toBeVisible();
    },
  );
});
