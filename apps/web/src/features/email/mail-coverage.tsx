import type {
  MailCoverage,
  MailCoverageRow,
} from "@cubby/schemas/mail-coverage";
import { humanize } from "@cubby/shared";
import { ACTIVE_RUN_STATUSES } from "@cubby/shared/client-constants";
import { countLabel } from "@cubby/shared/pluralize";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useId, useMemo, useState } from "react";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { useActionMutation } from "~/entity/hooks/use-action-mutation";
import RTable from "~/entity/table/table";
import { run } from "~/integrations/tanstack-query/generated/catalog/run.gen";
import { householdLocalDate } from "~/lib/household-date";
import { DateDisplay } from "~/ui/common/date-display";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
} from "~/ui/data-table/table-features";
import { attachCubbyColumnMeta } from "~/ui/data-table/table-meta";
import { useLocalTable } from "~/ui/data-table/use-local-table";
import { DatePickerInput } from "~/ui/date-picker-input";
import { EmptyState } from "~/ui/feedback/empty-state";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { useHydratedLoading } from "~/ui/hooks/use-hydrated";
import { Badge } from "~/ui/primitives/badge";
import { Button } from "~/ui/primitives/button";
import { StatusText } from "~/ui/primitives/status-text";

const activeRunStatuses = new Set<string>(ACTIVE_RUN_STATUSES);
const helper = createCubbyColumnHelper<MailCoverageRow>();
const rowId = (row: MailCoverageRow) => row.key;
const states = {
  no_search_identity: "No search identity",
  not_started: "Not searched",
  in_progress: "Searching",
  no_matches: "No matches",
  matches_found: "Matches found",
  complete: "Search complete",
} satisfies Record<MailCoverageRow["state"], string>;

function controlledStatus(row: MailCoverageRow): string {
  const control = row.controlledRun;
  if (!control) return "Not requested";
  if (control.queued) return "Waiting for active work";
  if (control.imports.running > 0) return "Importing";
  if (control.imports.failed > 0) return "Import failed";
  if (control.imports.needsReview > 0) return "Needs review";
  return `Search ${humanize(control.status).toLowerCase()}`;
}

function ControlledRunStatus({ row }: { row: MailCoverageRow }) {
  const controlled = row.controlledRun;
  if (!controlled)
    return <span className="text-muted-foreground">Not requested</span>;
  return (
    <span className="flex flex-wrap items-center gap-2">
      <EntityRefLink entity="run" id={controlled.id} />
      <span>
        {controlled.queued
          ? "Waiting for active work"
          : `Search ${humanize(controlled.status).toLowerCase()}`}
      </span>
      {controlled.phase ? (
        <span className="text-muted-foreground">
          {humanize(controlled.phase)}
        </span>
      ) : null}
      <span>
        Scope:{" "}
        {controlled.from || controlled.to ? (
          <DateDisplay start={controlled.from} end={controlled.to} />
        ) : (
          "All history"
        )}
      </span>
      <span>
        {[
          controlled.imports.running
            ? `${countLabel(controlled.imports.running, "import")} active`
            : null,
          controlled.imports.needsReview
            ? `${countLabel(controlled.imports.needsReview, "import")} need review`
            : null,
          controlled.imports.failed
            ? `${countLabel(controlled.imports.failed, "import")} failed`
            : null,
          controlled.imports.completed
            ? `${countLabel(controlled.imports.completed, "import")} completed`
            : null,
        ]
          .filter(Boolean)
          .join(" · ") || "No import Runs"}
      </span>
    </span>
  );
}

function initialControlledMailDraft() {
  return { from: "", to: householdLocalDate(), previewEnabled: false };
}

function ControlledMailImport({
  row,
  mailbox,
  draft,
  onDraftChange,
}: {
  row: MailCoverageRow;
  mailbox: MailCoverage["mailboxes"][number];
  draft: ReturnType<typeof initialControlledMailDraft>;
  onDraftChange: (draft: ReturnType<typeof initialControlledMailDraft>) => void;
}) {
  const formId = useId();
  const { from, to, previewEnabled } = draft;
  const canPreview = mailbox.canControl && row.searchesTotal > 0;
  const preview = useQuery({
    ...run.mailMatchPreview.queryOptions({
      mailboxId: row.mailboxId,
      vendorId: row.vendorId,
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
    }),
    enabled: previewEnabled && canPreview,
    staleTime: 30_000,
    retry: false,
  });
  const control = useActionMutation({
    mutationFn: () => run.controlledMailImport.mutationOptions(),
    error: "Couldn't start controlled import",
  });
  const resume = useActionMutation({
    mutationFn: () => run.resumeControlledMailImport.mutationOptions(),
    success: "Previous Mail import setting restored",
    error: "Couldn't resume automatic Mail import",
  });
  const alreadyRunning =
    row.controlledRun !== null &&
    (activeRunStatuses.has(row.controlledRun.status) ||
      row.controlledRun.imports.running > 0);
  const canControl =
    mailbox.canControl && row.searchesTotal > 0 && !alreadyRunning;
  return (
    <section className="space-y-3 border-t py-4" aria-label="Controlled import">
      <h2 className="text-base font-semibold">Import selected Vendor</h2>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <EntityRefLink
          entity="vendor"
          id={row.vendorId}
          name={row.vendorName}
        />
        <span>{mailbox.label}</span>
        <span className="text-xs text-muted-foreground">
          Automatic import{" "}
          {mailbox.enabled
            ? "on"
            : mailbox.resumeEnabled !== null
              ? "paused"
              : "off"}
        </span>
      </div>
      <p className="max-w-prose text-xs text-muted-foreground">
        Pauses other automatic imports for this mailbox until you resume them.
        Active work finishes first, then this Vendor is searched and imported.
        Paid AI may run within the household budget. From includes all earlier
        history by default; Through starts at today. Clear both dates for all
        history.
      </p>
      {!mailbox.canControl ? (
        <StatusText>
          Only the connected mailbox member can control this import.
        </StatusText>
      ) : null}
      {row.searchesTotal === 0 ? (
        <StatusText>
          Add a sender or domain to the Vendor before searching.
        </StatusText>
      ) : null}
      {row.searchTerms.length > 0 ? (
        <p className="text-xs break-words text-muted-foreground">
          Search identity: {row.searchTerms.join(" · ")}
        </p>
      ) : null}
      {row.controlledRun ? (
        <output className="block text-sm">
          <ControlledRunStatus row={row} />
        </output>
      ) : null}
      <form
        id={`${formId}-range`}
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!canControl || control.isPending) return;
          control.mutate({
            mailboxId: row.mailboxId,
            vendorId: row.vendorId,
            ...(from ? { from } : {}),
            ...(to ? { to } : {}),
          });
        }}
      >
        <div className="space-y-1 text-xs max-sm:w-full">
          <label htmlFor={`${formId}-from`}>From</label>
          <DatePickerInput
            id={`${formId}-from`}
            value={from || null}
            max={to || undefined}
            placeholder="Beginning of history"
            aria-describedby={`${formId}-date-hint`}
            clearable
            className="w-48 max-sm:w-full"
            disabled={!canPreview || control.isPending}
            onChange={(value) => onDraftChange({ ...draft, from: value ?? "" })}
          />
        </div>
        <div className="space-y-1 text-xs max-sm:w-full">
          <label htmlFor={`${formId}-to`}>Through</label>
          <DatePickerInput
            id={`${formId}-to`}
            value={to || null}
            min={from || undefined}
            placeholder="No end date"
            aria-describedby={`${formId}-date-hint`}
            clearable
            className="w-48 max-sm:w-full"
            disabled={!canPreview || control.isPending}
            onChange={(value) => onDraftChange({ ...draft, to: value ?? "" })}
          />
        </div>
      </form>
      <p id={`${formId}-date-hint`} className="text-xs text-muted-foreground">
        Type dates naturally, such as “1 year ago” or “today”, then press Enter
        or leave the field.
      </p>
      <div className="space-y-2">
        <Button
          type="button"
          form={`${formId}-range`}
          variant="outline"
          disabled={!canPreview || preview.isFetching}
          onClick={(event) => {
            if (!event.currentTarget.form?.reportValidity()) return;
            if (previewEnabled) void preview.refetch();
            else onDraftChange({ ...draft, previewEnabled: true });
          }}
        >
          {preview.isFetching
            ? "Checking Gmail…"
            : previewEnabled
              ? "Refresh Gmail matches"
              : "Check Gmail matches"}
        </Button>
        <div aria-live="polite" className="text-sm">
          {preview.isFetching ? (
            <StatusText>Checking the selected dates in Gmail…</StatusText>
          ) : previewEnabled && preview.data ? (
            <div className="space-y-1">
              <p>
                {preview.data.matchedMessages === null
                  ? "Gmail did not provide a match count."
                  : `${preview.data.approximate ? "About " : ""}${countLabel(preview.data.matchedMessages, "matching message")}`}
              </p>
              <p className="text-xs text-muted-foreground">
                Candidate matches in Gmail; import rules still apply. Updates
                when you choose new dates.
              </p>
              <DateDisplay timestamp={preview.data.checkedAt} />
              <details className="text-xs">
                <summary>Gmail search</summary>
                <p className="mt-1 break-words">{preview.data.query}</p>
              </details>
            </div>
          ) : null}
        </div>
        {previewEnabled && preview.error ? (
          <ErrorDisplay error={preview.error} />
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          form={`${formId}-range`}
          disabled={!canControl || control.isPending}
        >
          {control.isPending ? "Starting import…" : "Start controlled import"}
        </Button>
        {mailbox.resumeEnabled !== null ? (
          <Button
            type="button"
            variant="outline"
            disabled={
              !mailbox.canControl || resume.isPending || control.isPending
            }
            onClick={() => resume.mutate({ mailboxId: row.mailboxId })}
          >
            {resume.isPending
              ? "Resuming…"
              : mailbox.resumeEnabled
                ? "Resume automatic import"
                : "Resume queued imports; keep automatic off"}
          </Button>
        ) : null}
      </div>
      {control.error ? <ErrorDisplay error={control.error} /> : null}
      {resume.error ? <ErrorDisplay error={resume.error} /> : null}
      {control.data && row.controlledRun?.id !== control.data.run ? (
        <output className="flex flex-wrap items-center gap-2 text-sm">
          <EntityRefLink entity="run" id={control.data.run} />
          <span>
            {control.data.state === "queued"
              ? "Waiting for active work to finish. Follow the Run for search and import progress."
              : "Search and import started. Follow the Run for progress."}
          </span>
        </output>
      ) : null}
    </section>
  );
}

function CoverageTable({
  coverage,
  vendorId,
  mailboxId,
  accountId,
}: {
  coverage: MailCoverage;
  vendorId?: string;
  mailboxId?: string;
  accountId?: string;
}) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  // Responsive inspectors move between containers; the selection owner retains its draft.
  const [draft, setDraft] = useState(initialControlledMailDraft);
  const rows = useMemo(
    () =>
      coverage.rows.filter(
        (row) =>
          (!vendorId || row.vendorId === vendorId) &&
          (!accountId || row.vendorAccountId === accountId) &&
          (!mailboxId || row.mailboxId === mailboxId),
      ),
    [coverage.rows, vendorId, mailboxId, accountId],
  );
  const mailboxes = useMemo(
    () =>
      new Map(
        coverage.mailboxes.map((mailbox) => [mailbox.mailboxId, mailbox]),
      ),
    [coverage.mailboxes],
  );
  const search = useMemo(
    () => ({
      text: (row: MailCoverageRow) =>
        [
          row.vendorName,
          mailboxes.get(row.mailboxId)?.label,
          ...row.searchTerms,
          states[row.state],
        ].join(" "),
      placeholder: "Search Vendors, members, senders or domains",
    }),
    [mailboxes],
  );
  const columns = useMemo(
    () =>
      createCubbyColumnCollection<MailCoverageRow>((add) => {
        add(
          helper.accessor("vendorName", {
            header: "Vendor",
            size: 200,
            meta: attachCubbyColumnMeta<MailCoverageRow>({
              mobile: { slot: "title", priority: 0, renderTitle: true },
            }),
            cell: ({ row }) => (
              <EntityRefLink
                entity="vendor"
                id={row.original.vendorId}
                name={row.original.vendorName}
              />
            ),
          }),
        );
        add(
          helper.accessor(
            (row) =>
              mailboxes.get(row.mailboxId)?.label ?? "Unavailable mailbox",
            {
              id: "mailbox",
              header: "Member mailbox",
              size: 200,
              filterFn: "equals",
              meta: attachCubbyColumnMeta<MailCoverageRow>({
                mobile: { slot: "meta", priority: 0 },
                filterConfig: {
                  filterType: "select",
                  placeholder: "Filter mailbox",
                  options: coverage.mailboxes.map((mailbox) => ({
                    value: mailbox.label,
                    label: mailbox.label,
                  })),
                  facetCount: true,
                },
              }),
            },
          ),
        );
        add(
          helper.accessor("vendorAccountId", {
            header: "Vendor account",
            size: 180,
            cell: ({ getValue }) => {
              const id = getValue();
              return id ? (
                <EntityRefLink entity="vendorAccount" id={id} />
              ) : (
                <span className="text-muted-foreground">None</span>
              );
            },
          }),
        );
        add(
          helper.accessor("state", {
            header: "Coverage",
            size: 160,
            filterFn: "equals",
            meta: attachCubbyColumnMeta<MailCoverageRow>({
              mobile: { slot: "trailing", priority: 0 },
              filterConfig: {
                filterType: "select",
                placeholder: "Filter coverage",
                options: Object.entries(states).map(([value, label]) => ({
                  value,
                  label,
                })),
                facetCount: true,
              },
            }),
            cell: ({ getValue }) => (
              <Badge
                variant={
                  getValue() === "in_progress"
                    ? "default"
                    : getValue() === "no_search_identity"
                      ? "warning"
                      : "secondary"
                }
              >
                {states[getValue()]}
              </Badge>
            ),
          }),
        );
        add(
          helper.accessor(
            (row) =>
              row.searchesTotal ? row.searchesCompleted / row.searchesTotal : 0,
            {
              id: "searches",
              header: "Searches",
              size: 90,
              cell: ({ row }) => (
                <span className="font-mono tabular-nums">
                  {row.original.searchesCompleted}/{row.original.searchesTotal}
                </span>
              ),
            },
          ),
        );
        for (const [key, label] of [
          ["scanned", "Scanned Emails"],
          ["classified", "Classified Emails"],
          ["retained", "Retained Emails"],
          ["linkedEmails", "Linked Emails"],
          ["linkedPurchases", "Linked Purchases"],
        ] satisfies [
          keyof Pick<
            MailCoverageRow,
            | "scanned"
            | "classified"
            | "retained"
            | "linkedEmails"
            | "linkedPurchases"
          >,
          string,
        ][]) {
          add(
            helper.accessor(key, {
              header: label,
              size: 110,
              meta: attachCubbyColumnMeta<MailCoverageRow>({
                columnGroup:
                  key === "linkedEmails" || key === "linkedPurchases"
                    ? "Linked evidence"
                    : "Local Emails",
              }),
              cell: ({ getValue }) => (
                <span className="font-mono tabular-nums">{getValue()}</span>
              ),
            }),
          );
        }
        add(
          helper.accessor("lastSearchedAt", {
            header: "Last searched",
            size: 120,
            cell: ({ getValue }) => {
              const timestamp = getValue();
              return timestamp ? (
                <DateDisplay timestamp={timestamp} />
              ) : (
                <span
                  className="text-muted-foreground"
                  title="No recorded search completion time"
                >
                  —
                </span>
              );
            },
          }),
        );
        add(
          helper.accessor(controlledStatus, {
            id: "controlledImport",
            header: "Controlled import",
            size: 160,
            cell: ({ row, getValue }) =>
              row.original.controlledRun ? (
                <EntityRefLink
                  entity="run"
                  id={row.original.controlledRun.id}
                  name={getValue()}
                />
              ) : (
                <span className="text-muted-foreground">—</span>
              ),
          }),
        );
      }),
    [coverage.mailboxes, mailboxes],
  );
  const table = useLocalTable({ rows, columns, getRowId: rowId, search });
  const selected = coverage.rows.find((row) => row.key === selectedKey);
  const mailbox = selected ? mailboxes.get(selected.mailboxId) : undefined;
  return (
    <>
      {vendorId || mailboxId || accountId ? (
        <p className="text-xs text-muted-foreground">
          Showing linked record context.{" "}
          <Link to="/emails/coverage" search={{}} className="underline">
            Show all Vendors and mailboxes
          </Link>
        </p>
      ) : null}
      <RTable
        table={table}
        ariaLabel="Mail coverage by Vendor and mailbox"
        embedded
        withoutImages="Coverage rows use canonical Vendor links."
        currentRowId={selectedKey ?? undefined}
        onRowClick={(row) => {
          if (row.original.key !== selectedKey)
            setDraft(initialControlledMailDraft());
          setSelectedKey(row.original.key);
        }}
        disableMobileDetailsHref
        inspector={{
          title: "Controlled mail import",
          onClose: () => setSelectedKey(null),
          content:
            selected && mailbox ? (
              <ControlledMailImport
                key={selected.key}
                row={selected}
                mailbox={mailbox}
                draft={draft}
                onDraftChange={setDraft}
              />
            ) : null,
        }}
        emptyState={
          <EmptyState
            size="inline"
            description="Connect Gmail in Settings, or clear filters to see all Vendors."
          >
            No coverage rows
          </EmptyState>
        }
      />
    </>
  );
}

export function MailCoveragePage({
  vendorId,
  mailboxId,
  accountId,
}: {
  vendorId?: string;
  mailboxId?: string;
  accountId?: string;
}) {
  const query = useQuery({
    ...run.mailCoverage.queryOptions({}),
    refetchInterval: (current) =>
      current.state.data?.mailboxes.some((mailbox) => mailbox.enabled) ||
      current.state.data?.rows.some(
        (row) =>
          row.state === "in_progress" ||
          (row.controlledRun !== null &&
            (activeRunStatuses.has(row.controlledRun.status) ||
              row.controlledRun.imports.running > 0)),
      )
        ? 30_000
        : false,
  });
  const loading = useHydratedLoading(query.isPending);
  return (
    <div className="min-w-0 space-y-3">
      <p className="max-w-prose text-xs text-muted-foreground">
        Every Vendor appears once per connected mailbox, including Vendors with
        no mail. Select a row to import that Vendor. Counts cover local
        sender/domain candidates or attributed evidence, not Gmail totals. A
        matching domain does not establish Vendor attribution. Linked Purchases
        are distinct records. Search completion does not mean all purchases were
        imported; follow the controlled import Run for its outcome. Counts cover
        recorded history; import dates do not filter this table.
      </p>
      {loading ? <StatusText>Loading Mail coverage…</StatusText> : null}
      {query.error ? (
        <div className="space-y-2">
          <ErrorDisplay error={query.error} />
          <Button
            variant="outline"
            size="sm"
            onClick={() => void query.refetch()}
          >
            Retry coverage
          </Button>
        </div>
      ) : null}
      {query.data ? (
        <CoverageTable
          coverage={query.data}
          vendorId={vendorId}
          mailboxId={mailboxId}
          accountId={accountId}
        />
      ) : null}
    </div>
  );
}
