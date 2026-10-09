import {
  financialTransactionKind,
  type FinancialStatementImportPreviewOut,
  type FinancialTransactionKind,
} from "@cubby/schemas/financial-transaction";
import { financialTransactionShortcode } from "@cubby/schemas/identifiers";
import type { StatementCsvFileInput } from "@cubby/schemas/statement-row";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";

import {
  type CsvColumnMapping,
  fingerprintStatementCsv,
  parseMappedStatementCsv,
  parseStatementCsv,
  recognizedStatementSource,
  recordStatementBatch,
  statementCsvHeaders,
} from "~/app/finance/statement-csv";
import { statementRow } from "~/integrations/tanstack-query/generated/statement-row.gen";
import { pageTitle } from "~/lib/page-title";
import { statusTone } from "~/lib/status-tone";
import { formatCount, formatCurrency } from "~/lib/utils";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { useHydrationGate } from "~/ui/hooks/useHydrated";
import { Page } from "~/ui/page/Page";
import { Badge } from "~/ui/primitives/badge";
import { Button } from "~/ui/primitives/button";
import { NativeSelect } from "~/ui/primitives/native-select";

type ParsedImport = ReturnType<typeof parseStatementCsv>;
type RecordStatementRowsOut = Awaited<
  ReturnType<typeof statementRow.record.call>
>;
type Review = {
  fileName: string;
  fileInput: StatementCsvFileInput;
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
      return "Provider identity needs review";
  }
}

function confirmationLabel(
  busy: boolean,
  progress: string | null,
  missingKinds: boolean,
  attachments: number,
  selected: number,
  rows: number,
) {
  if (busy) return progress ?? "Saving…";
  if (missingKinds) return "Choose transaction kinds";
  if (attachments)
    return `Save rows and attach ${attachments} reviewed observations`;
  if (selected) return `Save rows and create ${selected} reviewed transactions`;
  return `Save ${formatCount(rows)} source rows`;
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
  const [attachments, setAttachments] = useState<Record<string, string>>({});
  const commitCsv = useMutation(statementRow.commitCsv.mutationOptions());
  const [busy, setBusy] = useState(false);
  const fileGate = useHydrationGate(busy);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<{
    transactions: number;
    attached: number;
    evidence: number;
    alreadyPresent: number;
  } | null>(null);

  async function prepareReview(
    parsed: ParsedImport,
    fileName: string,
    fileInput: StatementCsvFileInput,
  ) {
    const [filePreview, dryRun] = await Promise.all([
      statementRow.previewCsv.call(fileInput),
      statementRow.record.call({
        ...recordStatementBatch(parsed),
        dryRun: true,
      }),
    ]);
    setReview({
      fileName,
      fileInput,
      parsed,
      preview: filePreview.preview,
      dryRun,
    });
    setAttachments({});
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
          { fileName: file.name, text },
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
        { fileName: mappingFile.fileName, text: mappingFile.text, mapping },
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
      setProgress("Saving reviewed statement decisions…");
      const committed = await commitCsv.mutateAsync({
        ...review.fileInput,
        selected: [
          ...selected.map((key) => ({ key, kind: kinds[key] })),
          ...Object.entries(attachments).flatMap(([key, transactionId]) =>
            transactionId
              ? [
                  {
                    key,
                    transactionId:
                      financialTransactionShortcode.parse(transactionId),
                  },
                ]
              : [],
          ),
        ],
      });
      setResult({
        transactions: committed.transactions,
        attached: committed.attached,
        evidence: committed.evidence,
        alreadyPresent: committed.alreadyPresent,
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
                  <NativeSelect
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
                  </NativeSelect>
                </label>
              ))}
              <label className="text-sm" htmlFor="statement-amount-convention">
                Amount convention
                <NativeSelect
                  id="statement-amount-convention"
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
                </NativeSelect>
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
              source rows · {result.attached} observations attached ·{" "}
              {result.alreadyPresent} already present or indistinguishable
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
                  {formatCount(review.parsed.recordRows.length)} source rows ·{" "}
                  {review.parsed.source}
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
                    "No nonzero posted rows; all rows can be saved as evidence."
                  )}
                </p>
                {review.parsed.pending > 0 && (
                  <p className="text-xs text-muted-foreground">
                    {review.parsed.pending} pending rows will be saved as
                    evidence only.
                  </p>
                )}
                {review.parsed.zeroValueRows > 0 && (
                  <p className="text-xs text-warning-ink">
                    {review.parsed.zeroValueRows} zero-value rows will be
                    retained as source evidence without creating transactions.
                  </p>
                )}
              </div>
              <Button
                onClick={() => void confirm()}
                disabled={busy || selected.some((key) => !kinds[key])}
              >
                {confirmationLabel(
                  busy,
                  progress,
                  selected.some((key) => !kinds[key]),
                  Object.values(attachments).filter(Boolean).length,
                  selected.length,
                  review.parsed.recordRows.length,
                )}
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
                        <NativeSelect
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
                        </NativeSelect>
                      )}
                      {row.status === "possible_existing" &&
                        row.existingTransactionIds.length > 0 && (
                          <NativeSelect
                            aria-label={`Attach existing transaction for ${row.proposed.rawDescription ?? row.key}`}
                            value={attachments[row.key] ?? ""}
                            disabled={busy}
                            onChange={(event) =>
                              setAttachments((before) => ({
                                ...before,
                                [row.key]: event.target.value,
                              }))
                            }
                            className="mt-2 w-full max-w-sm"
                          >
                            <option value="">
                              Keep unresolved; save evidence only
                            </option>
                            {row.existingTransactions.map((candidate) => (
                              <option key={candidate.id} value={candidate.id}>
                                {candidate.id} ·{" "}
                                {candidate.postedDate ??
                                  candidate.transactionDate}{" "}
                                · {formatCurrency(candidate.amount)} ·{" "}
                                {candidate.status}
                              </option>
                            ))}
                          </NativeSelect>
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
                      <Badge
                        variant={statusTone("statementImport", row.status)}
                      >
                        {statusLabel(row.status)}
                      </Badge>
                    </span>
                  </div>
                );
              })}
            </div>
            <p className="text-xs text-muted-foreground">
              Source rows are saved in bounded, retryable batches. Only checked
              rows with an explicit kind become transactions. For large files,
              use the statement worklist to review the remaining rows. Attaching
              an observation preserves existing source references and canonical
              transaction facts. Purchases and expense booking are reviewed
              separately.
            </p>
          </section>
        )}
      </div>
    </Page>
  );
}
