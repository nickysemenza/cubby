import {
  financialTransactionCreateInput,
  financialTransactionKind,
  type FinancialStatementImportPreviewOut,
  type FinancialTransactionKind,
} from "@cubby/schemas/financial-transaction";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";

import { financialTransaction } from "~/app/finance/finance.functions";
import {
  fingerprintMonarchCsv,
  parseMonarchCsv,
} from "~/app/finance/monarch-csv";
import { ErrorDisplay } from "~/components/feedback/error-display";
import { Page } from "~/components/page/Page";
import { Button } from "~/components/ui/button";
import { entityMutation } from "~/entities/entity-mutation.functions";
import { pageTitle } from "~/lib/page-title";
import { statementRow } from "~/lib/statement-row.functions";
import { formatCurrency } from "~/lib/utils";

type ParsedImport = ReturnType<typeof parseMonarchCsv>;
type RecordStatementRowsOut = Awaited<
  ReturnType<typeof statementRow.record.call>
>;
type Review = {
  fileName: string;
  parsed: ParsedImport;
  preview: FinancialStatementImportPreviewOut;
  dryRun: RecordStatementRowsOut;
};

export const Route = createFileRoute("/_authenticated/statement-rows/import")({
  component: StatementImportPage,
  head: () => ({ meta: [{ title: pageTitle("Import statement") }] }),
});

function statusLabel(
  status: FinancialStatementImportPreviewOut["rows"][number]["status"],
) {
  switch (status) {
    case "ready_to_create":
      return "Ready to record";
    case "already_recorded":
      return "Already recorded";
    case "possible_existing":
      return "Review possible duplicate";
    case "unresolved_account":
      return "Account needs review";
    case "indistinguishable_duplicate":
      return "Duplicate rows in file";
  }
}

function StatementImportPage() {
  const [review, setReview] = useState<Review | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [kinds, setKinds] = useState<Record<string, FinancialTransactionKind>>(
    {},
  );
  const createTransaction = useMutation(
    entityMutation.mutate.forEntity("financialTransaction").mutationOptions(),
  );
  const recordRows = useMutation(statementRow.record.mutationOptions());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<{
    transactions: number;
    evidence: number;
    withheld: number;
  } | null>(null);

  async function openFile(file: File) {
    setBusy(true);
    setError(null);
    setReview(null);
    setResult(null);
    setKinds({});
    try {
      const parsed = parseMonarchCsv(
        await file.text(),
        file.name,
        await fingerprintMonarchCsv(file),
      );
      const [preview, dryRun] = await Promise.all([
        financialTransaction.previewStatementImport.call(parsed.preview),
        statementRow.record.call({ ...parsed.record, dryRun: true }),
      ]);
      setReview({ fileName: file.name, parsed, preview, dryRun });
      setSelected(
        preview.rows
          .filter((row) => row.status === "ready_to_create")
          .map((row) => row.key),
      );
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!review) return;
    if (selected.some((key) => !kinds[key])) return;
    setBusy(true);
    setError(null);
    try {
      // A second preview catches a transaction written since the file was
      // opened. Source refs make a retry after a partial failure resumable.
      const current = await financialTransaction.previewStatementImport.call(
        review.parsed.preview,
      );
      let transactions = 0;
      for (const row of current.rows) {
        if (row.status !== "ready_to_create" || !selected.includes(row.key))
          continue;
        if (!row.accountId) throw new Error(`No account for row ${row.key}`);
        const proposed = row.proposed;
        const kind = kinds[row.key];
        if (!kind) throw new Error(`Choose a transaction kind for ${row.key}`);
        const data = financialTransactionCreateInput.parse({
          accountId: row.accountId,
          purchaseId: null,
          kind,
          status: proposed.status,
          amount: proposed.amount,
          transactionDate: proposed.transactionDate,
          postedDate: proposed.postedDate,
          merchant: proposed.merchant,
          rawDescription: proposed.rawDescription,
          sourceCategory: proposed.sourceCategory,
          sourceRefs: [proposed.sourceRef],
          notes: proposed.notes,
        });
        await createTransaction.mutateAsync({
          entity: "financialTransaction",
          action: "create",
          data,
        });
        transactions++;
      }
      const recorded = await recordRows.mutateAsync(review.parsed.record);
      setResult({
        transactions,
        evidence: recorded.inserted,
        withheld:
          current.rows.length - transactions - current.summary.alreadyRecorded,
      });
      setReview(null);
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page
      variant="list"
      title="Import statement"
      eyebrow="Finance"
      compact
      decoration="none"
      actions={
        <Button
          variant="outline"
          render={<Link to="/statement-rows" />}
          nativeButton={false}
        >
          Statement rows
        </Button>
      }
    >
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 py-5">
        <div className="border-b border-border pb-5">
          <p className="text-sm text-muted-foreground">
            Choose a Monarch CSV. Cubby reads it in this browser, then shows
            account and duplicate checks before you confirm. Rows that need
            judgment stay visible in the statement worklist.
          </p>
          <label className="mt-4 flex min-h-20 cursor-pointer items-center justify-center rounded-sm border border-dashed border-border bg-card px-4 text-sm font-medium hover:border-primary">
            <input
              aria-label="Monarch CSV file"
              type="file"
              accept=".csv,text/csv"
              className="sr-only"
              disabled={busy}
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                if (file) void openFile(file);
                event.currentTarget.value = "";
              }}
            />
            {busy ? "Working…" : "Choose Monarch CSV"}
          </label>
        </div>

        {error !== null && <ErrorDisplay error={error} />}

        {result && (
          <output className="rounded-sm border border-border bg-card p-4">
            <p className="text-sm font-semibold">Statement recorded</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {result.transactions} transactions created · {result.evidence} new
              source rows · {result.withheld} held for review
            </p>
            <Button
              className="mt-3"
              variant="outline"
              render={<Link to="/statement-rows" />}
              nativeButton={false}
            >
              Review statement rows
            </Button>
          </output>
        )}

        {review && (
          <section aria-label="Statement preview" className="space-y-4">
            <div className="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-3">
              <div>
                <p className="text-xs tracking-wide text-muted-foreground uppercase">
                  {review.fileName}
                </p>
                <h2 className="mt-1 text-lg font-semibold">
                  Review {review.preview.summary.rowsIn}{" "}
                  {review.preview.summary.rowsIn === 1 ? "row" : "rows"}
                </h2>
                <p className="text-xs text-muted-foreground">
                  {review.preview.summary.readyToCreate} ready ·{" "}
                  {review.preview.summary.alreadyRecorded} recorded ·{" "}
                  {review.preview.summary.unresolvedAccount +
                    review.preview.summary.possibleExisting +
                    review.preview.summary.indistinguishableDuplicate}{" "}
                  need review
                </p>
              </div>
              <Button
                onClick={() => void confirm()}
                disabled={busy || selected.some((key) => !kinds[key])}
              >
                {busy
                  ? "Recording…"
                  : selected.some((key) => !kinds[key])
                    ? "Choose transaction kinds"
                    : `Confirm ${selected.length} ${selected.length === 1 ? "transaction" : "transactions"}`}
              </Button>
            </div>
            {review.dryRun.signWarning && (
              <p role="alert" className="text-sm text-destructive">
                {review.dryRun.signWarning}
              </p>
            )}
            <div className="divide-y divide-border rounded-sm border border-border bg-card">
              {review.preview.rows.map((row) => {
                const ready = row.status === "ready_to_create";
                return (
                  <div
                    key={row.key}
                    className="grid min-h-20 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-3 py-2 max-sm:grid-cols-[auto_minmax(0,1fr)]"
                  >
                    <input
                      type="checkbox"
                      aria-label={`Record ${row.proposed.rawDescription ?? row.key}`}
                      checked={ready && selected.includes(row.key)}
                      disabled={!ready || busy}
                      onChange={(event) =>
                        setSelected((before) =>
                          event.target.checked
                            ? [...before, row.key]
                            : before.filter((key) => key !== row.key),
                        )
                      }
                      className="size-4 accent-primary"
                    />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">
                        {row.proposed.rawDescription ??
                          row.proposed.merchant ??
                          row.key}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {row.proposed.postedDate} ·{" "}
                        {row.accountName ??
                          review.parsed.preview.rows.find(
                            (input) => input.key === row.key,
                          )?.account}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        Monarch category:{" "}
                        {row.proposed.sourceCategory || "Uncategorized"}
                      </span>
                      {ready && (
                        <select
                          aria-label={`Transaction kind for ${row.proposed.rawDescription ?? row.key}`}
                          value={kinds[row.key] ?? ""}
                          disabled={busy || !selected.includes(row.key)}
                          onChange={(event) =>
                            setKinds((before) => ({
                              ...before,
                              [row.key]: financialTransactionKind.parse(
                                event.target.value,
                              ),
                            }))
                          }
                          className="mt-1 h-8 min-w-40 rounded-sm border border-border bg-background px-2 text-sm"
                        >
                          <option value="">Choose transaction kind</option>
                          {financialTransactionKind.options.map((kind) => (
                            <option key={kind} value={kind}>
                              {kind.replaceAll("_", " ")}
                            </option>
                          ))}
                        </select>
                      )}
                      {!ready && row.existingTransactionIds.length > 0 && (
                        <span className="block text-xs text-muted-foreground">
                          Possible transaction:{" "}
                          {row.existingTransactionIds.join(", ")}
                        </span>
                      )}
                    </span>
                    <span className="col-start-2 flex items-center justify-between gap-3 sm:col-start-3 sm:flex-col sm:items-end">
                      <span className="font-mono text-sm tabular-nums">
                        {formatCurrency(row.proposed.amount)}
                      </span>
                      <span
                        className={
                          ready
                            ? "text-xs text-primary"
                            : "text-xs text-amber-700"
                        }
                      >
                        {statusLabel(row.status)}
                      </span>
                    </span>
                  </div>
                );
              })}
            </div>
            <p className="text-xs text-muted-foreground">
              Choose a kind for each selected row before recording. All source
              rows are retained, including those held for review. This does not
              create Purchases or invent a match; existing Purchase settlement
              is checked separately.
            </p>
          </section>
        )}
      </div>
    </Page>
  );
}
