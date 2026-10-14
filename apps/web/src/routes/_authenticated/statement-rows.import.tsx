import {
  financialTransactionKind,
  type FinancialStatementImportPreviewOut,
  type FinancialTransactionKind,
} from "@cubby/schemas/financial-transaction";
import { financialTransactionShortcode } from "@cubby/schemas/identifiers";
import type {
  StatementCsvColumnMapping,
  StatementCsvFileInput,
} from "@cubby/schemas/statement-row";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { statementRow } from "~/integrations/tanstack-query/generated/catalog.gen";
import { pageTitle } from "~/lib/page-title";
import { statusTone } from "~/lib/status-tone";
import { formatCount, formatCurrency } from "~/lib/utils";
import { Picker } from "~/ui/combobox/picker";
import type { PickerOption } from "~/ui/combobox/picker-option";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { useHydrationGate } from "~/ui/hooks/useHydrated";
import { Page } from "~/ui/page/Page";
import { Badge } from "~/ui/primitives/badge";
import { Button } from "~/ui/primitives/button";

type FilePreview = Awaited<ReturnType<typeof statementRow.previewCsv.call>>;
type Review = {
  fileName: string;
  fileInput: StatementCsvFileInput;
  file: FilePreview;
};
type MappingDraft = {
  fileName: string;
  text: string;
  headers: string[];
  mapping: StatementCsvColumnMapping;
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

const REQUIRED_MAPPING_FIELDS: ReadonlySet<string> = new Set([
  "date",
  "amount",
  "description",
]);
/** Above this many CSV headers a typed filter beats scanning the list. */
const CHOOSE_MODE_MAX = 12;

const mappingFieldName = (field: string) =>
  field === "accountColumn"
    ? "Account"
    : field[0]!.toUpperCase() + field.slice(1);

const AMOUNT_CONVENTION_OPTIONS: PickerOption[] = [
  { value: "charges-negative", label: "Charges are negative" },
  { value: "charges-positive", label: "Charges are positive" },
  {
    value: "direction-column",
    label: "Direction column says charge or credit",
  },
];

const TRANSACTION_KIND_OPTIONS: PickerOption[] =
  financialTransactionKind.options.map((kind) => ({
    value: kind,
    label: kind.replaceAll("_", " "),
  }));

type ExistingTransaction =
  FinancialStatementImportPreviewOut["rows"][number]["existingTransactions"][number];

/** Picks which existing transaction a possible-duplicate row attaches to,
 * or none (`""`); the value is the transaction id, never shown. */
function AttachTransactionPicker({
  label,
  candidates,
  value,
  disabled,
  onChange,
}: {
  label: string;
  candidates: readonly ExistingTransaction[];
  value: string;
  disabled: boolean;
  onChange: (id: string) => void;
}) {
  const options = useMemo(
    (): PickerOption[] => [
      { value: "", label: "Keep unresolved; save evidence only" },
      ...candidates.map((candidate) => ({
        value: candidate.id,
        label: candidate.rawDescription ?? candidate.merchant ?? "Transaction",
        detail: [
          candidate.postedDate ?? candidate.transactionDate,
          formatCurrency(candidate.amount),
          candidate.status,
        ]
          .filter(Boolean)
          .join(" · "),
      })),
    ],
    [candidates],
  );
  return (
    <Picker
      mode="choose"
      label={label}
      className="mt-2 w-full max-w-sm"
      options={options}
      value={value}
      disabled={disabled}
      onValueChange={(next) => onChange(next ?? "")}
    />
  );
}

function StatementImportPage() {
  const [review, setReview] = useState<Review | null>(null);
  const [mappingFile, setMappingFile] = useState<MappingDraft | null>(null);
  const mapping = mappingFile?.mapping;
  const headers = mappingFile?.headers;
  const headerOptions = useMemo(() => {
    const columns = (headers ?? []).map((header): PickerOption => ({
      value: header,
      label: header,
    }));
    return {
      required: [{ value: "", label: "Choose column" }, ...columns],
      optional: [{ value: "", label: "None" }, ...columns],
    };
  }, [headers]);
  const updateMapping = (patch: Partial<StatementCsvColumnMapping>) =>
    setMappingFile(
      (before) =>
        before && { ...before, mapping: { ...before.mapping, ...patch } },
    );
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

  async function prepareReview(fileInput: StatementCsvFileInput) {
    const file = await statementRow.previewCsv.call(fileInput);
    if (file.needsMapping && file.suggestedMapping) {
      setMappingFile({
        fileName: fileInput.fileName,
        text: fileInput.text,
        headers: file.headers,
        mapping: file.suggestedMapping,
      });
      return;
    }
    setReview({ fileName: fileInput.fileName, fileInput, file });
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
      await prepareReview({ fileName: file.name, text: await file.text() });
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
      await prepareReview({
        fileName: mappingFile.fileName,
        text: mappingFile.text,
        mapping: mappingFile.mapping,
      });
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
            Choose a statement CSV. Cubby checks source rows, accounts, and
            possible duplicates before saving. Transactions require a separate,
            explicit review decision.
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

        {mappingFile && mapping && (
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
                    updateMapping({ source: event.target.value })
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
                    updateMapping({ account: event.target.value })
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
                <div key={field} className="text-sm">
                  <span>
                    {mappingFieldName(field)} column
                    {REQUIRED_MAPPING_FIELDS.has(field) ? " *" : ""}
                  </span>
                  <Picker
                    mode={
                      headerOptions.required.length > CHOOSE_MODE_MAX
                        ? "search"
                        : "choose"
                    }
                    label={`${mappingFieldName(field)} column`}
                    className="mt-1 w-full"
                    options={
                      REQUIRED_MAPPING_FIELDS.has(field)
                        ? headerOptions.required
                        : headerOptions.optional
                    }
                    value={mapping[field]}
                    onValueChange={(next) =>
                      updateMapping({ [field]: next ?? "" })
                    }
                  />
                </div>
              ))}
              <div className="text-sm">
                <label htmlFor="statement-amount-convention">
                  Amount convention
                </label>
                <Picker
                  mode="choose"
                  inputId="statement-amount-convention"
                  label="Amount convention"
                  className="mt-1 w-full"
                  options={AMOUNT_CONVENTION_OPTIONS}
                  value={mapping.sign}
                  onValueChange={(sign) => {
                    if (
                      sign === "charges-negative" ||
                      sign === "charges-positive" ||
                      sign === "direction-column"
                    )
                      updateMapping({ sign });
                  }}
                />
              </div>
              {mapping.sign === "direction-column" && (
                <div className="flex gap-2">
                  <label className="text-sm">
                    Charge value
                    <input
                      className="mt-1 w-full rounded-sm border border-border bg-background px-2 py-2"
                      value={mapping.chargeValue}
                      onChange={(event) =>
                        updateMapping({ chargeValue: event.target.value })
                      }
                    />
                  </label>
                  <label className="text-sm">
                    Credit value
                    <input
                      className="mt-1 w-full rounded-sm border border-border bg-background px-2 py-2"
                      value={mapping.creditValue}
                      onChange={(event) =>
                        updateMapping({ creditValue: event.target.value })
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
                      updateMapping({ pendingValue: event.target.value })
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
                  {formatCount(review.file.totalRows)} source rows ·{" "}
                  {review.file.source}
                </h2>
                <p className="text-xs text-muted-foreground">
                  {review.file.preview ? (
                    <>
                      Previewing the first {review.file.preview.summary.rowsIn}{" "}
                      posted rows · {review.file.preview.summary.readyToCreate}{" "}
                      ready · {review.file.preview.summary.alreadyRecorded}{" "}
                      recorded ·{" "}
                      {review.file.preview.summary.unresolvedAccount +
                        review.file.preview.summary.possibleExisting +
                        review.file.preview.summary
                          .indistinguishableDuplicate}{" "}
                      need review
                    </>
                  ) : (
                    "No nonzero posted rows; all rows can be saved as evidence."
                  )}
                </p>
                {review.file.pendingRows > 0 && (
                  <p className="text-xs text-muted-foreground">
                    {review.file.pendingRows} pending rows will be saved as
                    evidence only.
                  </p>
                )}
                {review.file.zeroValueRows > 0 && (
                  <p className="text-xs text-warning-ink">
                    {review.file.zeroValueRows} zero-value rows will be retained
                    as source evidence without creating transactions.
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
                  review.file.totalRows,
                )}
              </Button>
            </div>
            {review.file.signWarning && (
              <p role="alert" className="text-sm text-destructive">
                {review.file.signWarning}
              </p>
            )}
            <div className="divide-y divide-border rounded-sm border border-border bg-card">
              {review.file.preview?.rows.map((row) => {
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
                        {row.accountName ?? row.provisionalAccount?.name}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {review.file.source} category:{" "}
                        {row.proposed.sourceCategory || "Uncategorized"}
                      </span>
                      {ready && (
                        <Picker
                          mode="choose"
                          compact
                          widthMode="intrinsic"
                          label={`Transaction kind for ${row.proposed.rawDescription ?? row.key}`}
                          placeholder="Choose transaction kind"
                          className="mt-1 min-w-40"
                          options={TRANSACTION_KIND_OPTIONS}
                          value={kinds[row.key] ?? null}
                          disabled={busy || !selected.includes(row.key)}
                          onValueChange={(next) => {
                            if (!next) return;
                            setKinds((before) => ({
                              ...before,
                              [row.key]: financialTransactionKind.parse(next),
                            }));
                          }}
                        />
                      )}
                      {row.status === "possible_existing" &&
                        row.existingTransactionIds.length > 0 && (
                          <AttachTransactionPicker
                            label={`Attach existing transaction for ${row.proposed.rawDescription ?? row.key}`}
                            candidates={row.existingTransactions}
                            value={attachments[row.key] ?? ""}
                            disabled={busy}
                            onChange={(next) =>
                              setAttachments((before) => ({
                                ...before,
                                [row.key]: next,
                              }))
                            }
                          />
                        )}
                      {!ready && row.existingTransactions.length > 0 && (
                        <span className="block text-xs text-muted-foreground">
                          Possible transaction:{" "}
                          {row.existingTransactions
                            .map(
                              (candidate) =>
                                candidate.rawDescription ??
                                candidate.merchant ??
                                "Transaction",
                            )
                            .join(", ")}
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
