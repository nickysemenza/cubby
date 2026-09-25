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
  type CsvColumnMapping,
  fingerprintStatementCsv,
  parseMappedStatementCsv,
  parseStatementCsv,
  previewStatementBatch,
  recognizedStatementSource,
  recordStatementBatch,
  statementCsvHeaders,
} from "~/app/finance/statement-csv";
import { ErrorDisplay } from "~/components/feedback/error-display";
import { Page } from "~/components/page/Page";
import { Button } from "~/components/ui/button";
import { entityMutation } from "~/entities/entity-mutation.functions";
import { useHydrationGate } from "~/hooks/useHydrated";
import { pageTitle } from "~/lib/page-title";
import { statementRow } from "~/lib/statement-row.functions";
import { formatCurrency } from "~/lib/utils";

type ParsedImport = ReturnType<typeof parseStatementCsv>;
type RecordStatementRowsOut = Awaited<
  ReturnType<typeof statementRow.record.call>
>;
type Review = {
  fileName: string;
  parsed: ParsedImport;
  preview: FinancialStatementImportPreviewOut | null;
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
  const [mappingFile, setMappingFile] = useState<{
    text: string;
    fileName: string;
    fingerprint: string;
    headers: string[];
  } | null>(null);
  const [mapping, setMapping] = useState<CsvColumnMapping>({
    source: "",
    account: "",
    accountColumn: "",
    date: "",
    amount: "",
    description: "",
    merchant: "",
    category: "",
    notes: "",
    direction: "",
    status: "",
    pendingValue: "pending",
    chargeValue: "debit",
    creditValue: "credit",
    sign: "charges-negative",
  });
  const [selected, setSelected] = useState<string[]>([]);
  const [kinds, setKinds] = useState<Record<string, FinancialTransactionKind>>(
    {},
  );
  const createTransaction = useMutation(
    entityMutation.mutate.forEntity("financialTransaction").mutationOptions(),
  );
  const recordRows = useMutation(statementRow.record.mutationOptions());
  const [busy, setBusy] = useState(false);
  const fileGate = useHydrationGate(busy);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<{
    transactions: number;
    evidence: number;
    alreadyPresentOrIndistinguishable: number;
  } | null>(null);

  async function prepareReview(parsed: ParsedImport, fileName: string) {
    const firstPreview = previewStatementBatch(parsed);
    const [preview, dryRun] = await Promise.all([
      firstPreview
        ? financialTransaction.previewStatementImport.call(firstPreview)
        : Promise.resolve(null),
      statementRow.record.call({
        ...recordStatementBatch(parsed),
        dryRun: true,
      }),
    ]);
    setReview({ fileName, parsed, preview, dryRun });
    setSelected([]);
    setMappingFile(null);
  }

  async function openFile(file: File) {
    setBusy(true);
    setError(null);
    setReview(null);
    setMappingFile(null);
    setResult(null);
    setKinds({});
    try {
      const text = await file.text();
      const fingerprint = await fingerprintStatementCsv(file);
      const headers = statementCsvHeaders(text);
      if (recognizedStatementSource(headers)) {
        await prepareReview(
          parseStatementCsv(text, file.name, fingerprint),
          file.name,
        );
      } else {
        setMappingFile({ text, fileName: file.name, fingerprint, headers });
        setMapping((before) => ({
          ...before,
          source: "",
          account: "",
          accountColumn:
            headers.find((header) => /account/i.test(header)) ?? "",
          merchant: "",
          category: "",
          notes: "",
          direction: "",
          status: headers.find((header) => /^status$/i.test(header)) ?? "",
          sign: "charges-negative",
          date:
            headers.find((header) => /date|when|posted|time/i.test(header)) ??
            "",
          amount:
            headers.find((header) => /amount|total|value|sum/i.test(header)) ??
            "",
          description:
            headers.find((header) =>
              /description|merchant|name|memo|details|payee/i.test(header),
            ) ?? "",
        }));
      }
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }

  async function previewMappedFile() {
    if (!mappingFile) return;
    setBusy(true);
    setError(null);
    try {
      await prepareReview(
        parseMappedStatementCsv(
          mappingFile.text,
          mappingFile.fileName,
          mappingFile.fingerprint,
          mapping,
        ),
        mappingFile.fileName,
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
      let evidence = 0;
      for (
        let offset = 0;
        offset < review.parsed.recordRows.length;
        offset += 500
      ) {
        setProgress(
          `Saving source rows ${offset + 1}–${Math.min(offset + 500, review.parsed.recordRows.length)} of ${review.parsed.recordRows.length}`,
        );
        const recorded = await recordRows.mutateAsync(
          recordStatementBatch(review.parsed, offset),
        );
        evidence += recorded.inserted;
      }
      // A second preview catches a transaction written since the file was
      // opened. Source refs make a retry after a partial failure resumable.
      const firstPreview = previewStatementBatch(review.parsed);
      const current =
        selected.length && firstPreview
          ? await financialTransaction.previewStatementImport.call(firstPreview)
          : null;
      let transactions = 0;
      for (const row of current?.rows ?? []) {
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
        setProgress(
          `Creating reviewed transactions ${transactions} of ${selected.length}`,
        );
      }
      setResult({
        transactions,
        evidence,
        alreadyPresentOrIndistinguishable:
          review.parsed.recordRows.length - evidence,
      });
      setReview(null);
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
      setProgress(null);
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
            Choose a statement CSV. Cubby reads it in this browser and checks
            source rows, accounts, and possible duplicates before saving.
            Transactions require a separate, explicit review decision.
          </p>
          <label className="mt-4 flex min-h-20 cursor-pointer items-center justify-center rounded-sm border border-dashed border-border bg-card px-4 text-sm font-medium hover:border-primary">
            <input
              aria-label="Statement CSV file"
              type="file"
              accept=".csv,text/csv"
              className="sr-only"
              {...fileGate}
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                if (file) void openFile(file);
                event.currentTarget.value = "";
              }}
            />
            {busy ? (progress ?? "Reading statement…") : "Choose statement CSV"}
          </label>
        </div>

        {error !== null && <ErrorDisplay error={error} />}

        {mappingFile && (
          <section
            aria-label="Map statement columns"
            className="space-y-4 rounded-sm border border-border bg-card p-4"
          >
            <div>
              <h2 className="text-lg font-semibold">
                Map this CSV once before review
              </h2>
              <p className="text-sm text-muted-foreground">
                {mappingFile.fileName} has unfamiliar columns. Check the amount
                direction against the first rows in your file before saving. No
                transaction is created from this mapping alone.
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-sm">
                Source name
                <input
                  className="mt-1 w-full rounded-sm border border-border bg-background px-2 py-2"
                  value={mapping.source}
                  onChange={(event) =>
                    setMapping((before) => ({
                      ...before,
                      source: event.target.value,
                    }))
                  }
                  placeholder="venmo"
                />
              </label>
              <label className="text-sm">
                Account name (for a single-account file)
                <input
                  className="mt-1 w-full rounded-sm border border-border bg-background px-2 py-2"
                  value={mapping.account}
                  onChange={(event) =>
                    setMapping((before) => ({
                      ...before,
                      account: event.target.value,
                    }))
                  }
                  placeholder="Checking (...1234)"
                />
              </label>
              {(
                [
                  "date",
                  "amount",
                  "description",
                  "accountColumn",
                  "merchant",
                  "category",
                  "notes",
                  "direction",
                  "status",
                ] as const
              ).map((field) => (
                <label key={field} className="text-sm">
                  {field === "accountColumn"
                    ? "Account"
                    : field[0]!.toUpperCase() + field.slice(1)}{" "}
                  column
                  {["date", "amount", "description"].includes(field)
                    ? " *"
                    : ""}
                  <select
                    aria-label={`${field === "accountColumn" ? "Account" : field[0]!.toUpperCase() + field.slice(1)} column`}
                    className="mt-1 w-full rounded-sm border border-border bg-background px-2 py-2"
                    value={mapping[field]}
                    onChange={(event) =>
                      setMapping((before) => ({
                        ...before,
                        [field]: event.target.value,
                      }))
                    }
                  >
                    <option value="">
                      {["date", "amount", "description"].includes(field)
                        ? "Choose column"
                        : "None"}
                    </option>
                    {mappingFile.headers.map((header) => (
                      <option key={header} value={header}>
                        {header}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
              <label className="text-sm">
                Amount convention
                <select
                  aria-label="Amount convention"
                  className="mt-1 w-full rounded-sm border border-border bg-background px-2 py-2"
                  value={mapping.sign}
                  onChange={(event) => {
                    const sign = event.target.value;
                    if (
                      sign === "charges-negative" ||
                      sign === "charges-positive" ||
                      sign === "direction-column"
                    )
                      setMapping((before) => ({ ...before, sign }));
                  }}
                >
                  <option value="charges-negative">Charges are negative</option>
                  <option value="charges-positive">Charges are positive</option>
                  <option value="direction-column">
                    Direction column says charge or credit
                  </option>
                </select>
              </label>
              {mapping.sign === "direction-column" && (
                <div className="flex gap-2">
                  <label className="text-sm">
                    Charge value
                    <input
                      className="mt-1 w-full rounded-sm border border-border bg-background px-2 py-2"
                      value={mapping.chargeValue}
                      onChange={(event) =>
                        setMapping((before) => ({
                          ...before,
                          chargeValue: event.target.value,
                        }))
                      }
                    />
                  </label>
                  <label className="text-sm">
                    Credit value
                    <input
                      className="mt-1 w-full rounded-sm border border-border bg-background px-2 py-2"
                      value={mapping.creditValue}
                      onChange={(event) =>
                        setMapping((before) => ({
                          ...before,
                          creditValue: event.target.value,
                        }))
                      }
                    />
                  </label>
                </div>
              )}
              {mapping.status && (
                <label className="text-sm">
                  Pending status value
                  <input
                    className="mt-1 w-full rounded-sm border border-border bg-background px-2 py-2"
                    value={mapping.pendingValue}
                    onChange={(event) =>
                      setMapping((before) => ({
                        ...before,
                        pendingValue: event.target.value,
                      }))
                    }
                  />
                </label>
              )}
            </div>
            <Button disabled={busy} onClick={() => void previewMappedFile()}>
              {busy ? "Checking rows…" : "Preview mapped rows"}
            </Button>
          </section>
        )}

        {result && (
          <output className="rounded-sm border border-border bg-card p-4">
            <p className="text-sm font-semibold">Statement recorded</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {result.transactions} transactions created · {result.evidence} new
              source rows · {result.alreadyPresentOrIndistinguishable} already
              present or indistinguishable
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
                  {review.parsed.recordRows.length.toLocaleString()} source rows
                  · {review.parsed.source}
                </h2>
                <p className="text-xs text-muted-foreground">
                  {review.preview ? (
                    <>
                      Previewing the first {review.preview.summary.rowsIn}{" "}
                      posted rows · {review.preview.summary.readyToCreate} ready
                      · {review.preview.summary.alreadyRecorded} recorded ·{" "}
                      {review.preview.summary.unresolvedAccount +
                        review.preview.summary.possibleExisting +
                        review.preview.summary.indistinguishableDuplicate}{" "}
                      need review
                    </>
                  ) : (
                    "No posted rows; pending rows can be saved as evidence."
                  )}
                </p>
                {review.parsed.pending > 0 && (
                  <p className="text-xs text-muted-foreground">
                    {review.parsed.pending} pending rows will be saved as
                    evidence only.
                  </p>
                )}
                {review.parsed.zeroValueRows > 0 && (
                  <p className="text-xs text-amber-700">
                    {review.parsed.zeroValueRows} zero-value rows cannot be
                    stored as financial statement rows and will be skipped.
                  </p>
                )}
              </div>
              <Button
                onClick={() => void confirm()}
                disabled={busy || selected.some((key) => !kinds[key])}
              >
                {busy
                  ? (progress ?? "Saving…")
                  : selected.some((key) => !kinds[key])
                    ? "Choose transaction kinds"
                    : selected.length > 0
                      ? `Save rows and create ${selected.length} reviewed transactions`
                      : `Save ${review.parsed.recordRows.length.toLocaleString()} source rows`}
              </Button>
            </div>
            {review.dryRun.signWarning && (
              <p role="alert" className="text-sm text-destructive">
                {review.dryRun.signWarning}
              </p>
            )}
            <div className="divide-y divide-border rounded-sm border border-border bg-card">
              {review.preview?.rows.map((row) => {
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
                          review.parsed.rows.find(
                            (input) => input.key === row.key,
                          )?.account}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {review.parsed.source} category:{" "}
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
              Nonzero source rows are saved in bounded, retryable batches. Only
              checked rows with an explicit kind become transactions. For large
              files, use the statement worklist to review the remaining rows.
              Purchases and settlement matches are reviewed separately.
            </p>
          </section>
        )}
      </div>
    </Page>
  );
}
