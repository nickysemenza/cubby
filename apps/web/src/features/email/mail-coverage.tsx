import { senderAttribution as senderAttributionSchema } from "@cubby/schemas/mail-coverage";
import type {
  MailCoverage,
  MailCoverageRow,
  MailCoverageView,
} from "@cubby/schemas/mail-coverage";
import { humanize } from "@cubby/shared";
import { ACTIVE_RUN_STATUSES } from "@cubby/shared/client-constants";
import { countLabel } from "@cubby/shared/pluralize";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useCallback, useId, useMemo, useState, type ReactNode } from "react";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { useActionMutation } from "~/entity/hooks/use-action-mutation";
import RTable from "~/entity/table/table";
import { SenderAttributionDetails } from "~/features/email/sender-attribution";
import { run } from "~/integrations/tanstack-query/generated/domains/run.gen";
import { householdLocalDate } from "~/lib/household-date";
import { DateDisplay } from "~/ui/common/date-display";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
} from "~/ui/data-table/table-features";
import { attachCubbyColumnMeta } from "~/ui/data-table/table-meta";
import { useLocalTable } from "~/ui/data-table/use-local-table";
import { DatePickerInput } from "~/ui/date-picker-input";
import { DateRangeShortcuts } from "~/ui/date-range-shortcuts";
import { EmptyState } from "~/ui/feedback/empty-state";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { useHydratedLoading } from "~/ui/hooks/use-hydrated";
import { SidePanel } from "~/ui/overlays/side-panel";
import { Badge } from "~/ui/primitives/badge";
import { Button } from "~/ui/primitives/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "~/ui/primitives/popover";
import { StatusText } from "~/ui/primitives/status-text";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "~/ui/primitives/tabs";

const activeRunStatuses = new Set<string>(ACTIVE_RUN_STATUSES);
const helper = createCubbyColumnHelper<MailCoverageRow>();
const rowId = (row: MailCoverageRow) => row.key;
const discoveryHelper =
  createCubbyColumnHelper<MailCoverage["discovery"][number]>();
const senderHelper =
  createCubbyColumnHelper<MailCoverage["sharedSenders"][number]>();
const unresolvedHelper =
  createCubbyColumnHelper<MailCoverage["unresolvedEmails"][number]>();

const discoveryRowId = (row: MailCoverage["discovery"][number]) =>
  row.mailboxId;
const senderRowId = (row: MailCoverage["sharedSenders"][number]) =>
  `${row.mailboxId}/${row.sender}`;
const unresolvedRowId = (row: MailCoverage["unresolvedEmails"][number]) =>
  row.id;

const coverageVendors = (coverage: MailCoverage) => [
  ...new Map(
    coverage.rows.map((row) => [
      row.vendorId,
      { id: row.vendorId, name: row.vendorName },
    ]),
  ).values(),
];

function CoverageDetails({
  label,
  facts,
  open,
}: {
  label: string;
  open?: boolean;
  facts: readonly (readonly [string, ReactNode])[];
}) {
  return (
    <details className="text-xs" open={open}>
      <summary className="cursor-pointer">{label}</summary>
      <dl className="space-y-1 pt-2">
        {facts.map(([name, value]) => (
          <div key={name} className="flex flex-wrap gap-x-2">
            <dt className="font-medium">{name}</dt>
            <dd className="min-w-0 break-words">{value}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

function SharedSenderDetails({
  sender,
  mailboxName,
  onSaved,
  vendors,
}: {
  sender: MailCoverage["sharedSenders"][number];
  mailboxName: (id: string) => string;
  onSaved: () => void;
  vendors: MailCoverage["senderAttributions"][number]["vendors"];
}) {
  return (
    <div className="space-y-4">
      <SenderAttributionDetails
        attribution={sender.attribution}
        vendors={vendors}
        onSaved={onSaved}
      />
      <CoverageDetails
        label="Sender details"
        open
        facts={[
          ["Sender", sender.sender],
          ["Mailbox", mailboxName(sender.mailboxId)],
          ["Historical search", sender.query],
          ["Search status", humanize(sender.state)],
          [
            "Completed",
            sender.completedAt ? (
              <DateDisplay key="completed" timestamp={sender.completedAt} />
            ) : (
              "Not recorded"
            ),
          ],
          ["Local Emails", sender.scanned],
          ["Classified", sender.classified],
          ["Content saved", sender.retained],
          ["Related", sender.related],
          ["Imported Emails", sender.imported],
          ["Linked Emails", sender.linkedEmails],
          ["Purchases", sender.linkedPurchases],
          ["Seller unresolved", sender.sellerUnresolved],
          [
            "Search Run",
            sender.runId ? (
              <EntityRefLink key="run" entity="run" id={sender.runId} />
            ) : (
              "—"
            ),
          ],
        ]}
      />
    </div>
  );
}

function DiscoveryCoverage({
  coverage,
  mailboxId,
}: {
  coverage: MailCoverage;
  mailboxId?: string;
}) {
  const [unresolvedOpen, setUnresolvedOpen] = useState(false);
  const [selectedSender, setSelectedSender] = useState<string | null>(null);
  const [senderView, setSenderView] = useState("all");
  const mailboxName = useCallback(
    (id: string) =>
      coverage.mailboxes.find((mailbox) => mailbox.mailboxId === id)?.label ??
      "Mailbox",
    [coverage.mailboxes],
  );
  const discoveryRows = useMemo(
    () =>
      coverage.discovery.filter(
        (row) => !mailboxId || row.mailboxId === mailboxId,
      ),
    [coverage.discovery, mailboxId],
  );
  const senderRows = useMemo(
    () =>
      coverage.sharedSenders.filter(
        (row) => !mailboxId || row.mailboxId === mailboxId,
      ),
    [coverage.sharedSenders, mailboxId],
  );
  const unresolvedRows = useMemo(
    () =>
      coverage.unresolvedEmails.filter(
        (row) => !mailboxId || row.mailboxId === mailboxId,
      ),
    [coverage.unresolvedEmails, mailboxId],
  );
  const unresolvedTotal = discoveryRows.reduce(
    (total, row) => total + row.sellerUnresolved,
    0,
  );
  const discoveryColumns = useMemo(
    () =>
      createCubbyColumnCollection<MailCoverage["discovery"][number]>((add) => {
        add(
          discoveryHelper.accessor("mailboxId", {
            header: "Mailbox",
            meta: attachCubbyColumnMeta<MailCoverage["discovery"][number]>({
              mobile: { slot: "title", priority: 0, renderTitle: true },
            }),
            cell: ({ getValue }) => mailboxName(getValue()),
          }),
        );
        add(
          discoveryHelper.display({
            id: "automaticImport",
            header: "Automatic import",
            cell: ({ row }) =>
              coverage.mailboxes.find(
                (mailbox) => mailbox.mailboxId === row.original.mailboxId,
              )?.enabled
                ? "On"
                : "Off",
          }),
        );
        add(
          discoveryHelper.accessor("lastPolledAt", {
            header: "Last discovery poll",
            meta: attachCubbyColumnMeta<MailCoverage["discovery"][number]>({
              mobile: { slot: "meta", priority: 0, showWhenEmpty: true },
            }),
            cell: ({ getValue }) => {
              const value = getValue();
              return value ? <DateDisplay timestamp={value} /> : "Not recorded";
            },
          }),
        );
        add(
          discoveryHelper.accessor("newMailCatchupPending", {
            header: "New-mail catch-up",
            meta: attachCubbyColumnMeta<MailCoverage["discovery"][number]>({
              mobile: { slot: "meta", priority: 1, showWhenEmpty: true },
            }),
            cell: ({ getValue }) =>
              getValue() === null
                ? "Unknown"
                : getValue()
                  ? "More pages pending"
                  : "No pending pages recorded",
          }),
        );
        add(
          discoveryHelper.display({
            id: "history",
            header: "Targeted history",
            meta: attachCubbyColumnMeta<MailCoverage["discovery"][number]>({
              mobile: { slot: "meta", priority: 2 },
            }),
            cell: ({ row }) =>
              `${row.original.searchesCompleted} / ${row.original.searchesTotal} searches complete`,
          }),
        );
        add(discoveryHelper.accessor("scanned", { header: "Local Emails" }));
        add(discoveryHelper.accessor("classified", { header: "Classified" }));
        add(discoveryHelper.accessor("retained", { header: "Content saved" }));
        add(discoveryHelper.accessor("pending", { header: "Pending Emails" }));
        add(discoveryHelper.accessor("blocked", { header: "Blocked" }));
        add(
          discoveryHelper.accessor("imported", { header: "Imported Emails" }),
        );
        add(
          discoveryHelper.accessor("runId", {
            header: "Discovery Run",
            cell: ({ row, getValue }) => {
              const id = getValue();
              return id ? (
                <EntityRefLink
                  entity="run"
                  id={id}
                  name={humanize(row.original.runStatus ?? "running")}
                />
              ) : (
                "—"
              );
            },
          }),
        );
        add(
          discoveryHelper.display({
            id: "details",
            header: "Details",
            meta: attachCubbyColumnMeta<MailCoverage["discovery"][number]>({
              mobile: { slot: "actions", priority: 0, interactive: true },
            }),
            cell: ({ row }) => (
              <CoverageDetails
                label="Discovery details"
                facts={[
                  [
                    "Automatic import",
                    coverage.mailboxes.find(
                      (mailbox) => mailbox.mailboxId === row.original.mailboxId,
                    )?.enabled
                      ? "On"
                      : "Off",
                  ],
                  [
                    "Last discovery poll",
                    row.original.lastPolledAt ? (
                      <DateDisplay
                        key="poll"
                        timestamp={row.original.lastPolledAt}
                      />
                    ) : (
                      "Not recorded"
                    ),
                  ],
                  [
                    "New-mail catch-up",
                    row.original.newMailCatchupPending === null
                      ? "Unknown"
                      : row.original.newMailCatchupPending
                        ? "More pages pending"
                        : "No pending pages recorded",
                  ],
                  [
                    "Targeted history",
                    `${row.original.searchesCompleted} / ${row.original.searchesTotal} searches complete`,
                  ],
                  ["Local Emails", row.original.scanned],
                  ["Classified", row.original.classified],
                  ["Content saved", row.original.retained],
                  ["Pending Emails", row.original.pending],
                  ["Blocked", row.original.blocked],
                  ["Imported Emails", row.original.imported],
                  [
                    "Discovery Run",
                    row.original.runId ? (
                      <EntityRefLink
                        key="run"
                        entity="run"
                        id={row.original.runId}
                        name={humanize(row.original.runStatus ?? "running")}
                      />
                    ) : (
                      "—"
                    ),
                  ],
                ]}
              />
            ),
          }),
        );
      }),
    [mailboxName, coverage.mailboxes],
  );
  const senderColumns = useMemo(
    () =>
      createCubbyColumnCollection<MailCoverage["sharedSenders"][number]>(
        (add) => {
          add(
            senderHelper.accessor("sender", {
              header: "Shared sender",
              size: 300,
              meta: attachCubbyColumnMeta<
                MailCoverage["sharedSenders"][number]
              >({ mobile: { slot: "title", priority: 0, renderTitle: true } }),
            }),
          );
          add(
            senderHelper.accessor((row) => row.attribution.state, {
              id: "attribution",
              header: "Attribution",
              cell: ({ getValue }) => (
                <Badge variant="outline">{humanize(getValue())}</Badge>
              ),
            }),
          );
          add(
            senderHelper.accessor("mailboxId", {
              header: "Mailbox",
              cell: ({ getValue }) => mailboxName(getValue()),
            }),
          );
          add(senderHelper.accessor("query", { header: "Historical search" }));
          add(
            senderHelper.accessor("state", {
              header: "Search status",
              meta: attachCubbyColumnMeta<
                MailCoverage["sharedSenders"][number]
              >({ mobile: { slot: "subtitle", priority: 0 } }),
              cell: ({ getValue }) => (
                <Badge variant="outline">{humanize(getValue())}</Badge>
              ),
            }),
          );
          add(
            senderHelper.accessor("completedAt", {
              header: "Completed",
              cell: ({ getValue }) => {
                const value = getValue();
                return value ? <DateDisplay timestamp={value} /> : "—";
              },
            }),
          );
          add(senderHelper.accessor("scanned", { header: "Local Emails" }));
          add(senderHelper.accessor("classified", { header: "Classified" }));
          add(senderHelper.accessor("retained", { header: "Content saved" }));
          add(senderHelper.accessor("related", { header: "Related" }));
          add(senderHelper.accessor("imported", { header: "Imported Emails" }));
          add(
            senderHelper.accessor("linkedEmails", { header: "Linked Emails" }),
          );
          add(
            senderHelper.accessor("linkedPurchases", { header: "Purchases" }),
          );
          add(
            senderHelper.accessor("sellerUnresolved", {
              header: "Seller unresolved",
            }),
          );
          add(
            senderHelper.accessor("runId", {
              header: "Search Run",
              cell: ({ getValue }) => {
                const id = getValue();
                return id ? <EntityRefLink entity="run" id={id} /> : "—";
              },
            }),
          );
          add(
            senderHelper.display({
              id: "details",
              header: "Details",
              meta: attachCubbyColumnMeta<
                MailCoverage["sharedSenders"][number]
              >({
                mobile: { slot: "actions", priority: 0, interactive: true },
              }),
              cell: ({ row }) => (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setSelectedSender(senderRowId(row.original))}
                >
                  Sender details
                </Button>
              ),
            }),
          );
        },
      ),
    [mailboxName],
  );
  const unresolvedColumns = useMemo(
    () =>
      createCubbyColumnCollection<MailCoverage["unresolvedEmails"][number]>(
        (add) => {
          add(
            unresolvedHelper.accessor("subject", {
              header: "Email",
              meta: attachCubbyColumnMeta<
                MailCoverage["unresolvedEmails"][number]
              >({ mobile: { slot: "title", priority: 0, renderTitle: true } }),
              cell: ({ row, getValue }) => (
                <EntityRefLink
                  entity="email"
                  id={row.original.id}
                  name={getValue() ?? "No subject"}
                />
              ),
            }),
          );
          add(unresolvedHelper.accessor("sender", { header: "Sender" }));
          add(
            unresolvedHelper.accessor("mailboxId", {
              header: "Mailbox",
              cell: ({ getValue }) => mailboxName(getValue()),
            }),
          );
          add(
            unresolvedHelper.accessor("receivedAt", {
              header: "Received",
              cell: ({ getValue }) => {
                const value = getValue();
                return value ? <DateDisplay timestamp={value} /> : "—";
              },
            }),
          );
        },
      ),
    [mailboxName],
  );
  const discoveryTable = useLocalTable({
    rows: discoveryRows,
    columns: discoveryColumns,
    getRowId: discoveryRowId,
  });
  const senderSearch = useMemo(
    () => ({
      text: (row: MailCoverage["sharedSenders"][number]) =>
        `${row.sender} ${mailboxName(row.mailboxId)} ${row.query}`,
      placeholder: "Search senders, mailboxes, or queries",
    }),
    [mailboxName],
  );
  const visibleSenders = useMemo(
    () =>
      senderRows.filter(
        (row) =>
          senderView === "all" ||
          (senderView === "unresolved"
            ? row.sellerUnresolved > 0
            : row.state === senderView),
      ),
    [senderRows, senderView],
  );
  const inspectedSender = senderRows.find(
    (row) => senderRowId(row) === selectedSender,
  );
  const senderTable = useLocalTable({
    rows: visibleSenders,
    columns: senderColumns,
    getRowId: senderRowId,
    search: senderSearch,
    initialVisibility: {
      query: false,
      completedAt: false,
      classified: false,
      retained: false,
      related: false,
      imported: false,
      linkedEmails: false,
      runId: false,
    },
  });
  const unresolvedTable = useLocalTable({
    rows: unresolvedRows,
    columns: unresolvedColumns,
    getRowId: unresolvedRowId,
    totalCount: unresolvedTotal,
  });
  return (
    <div className="space-y-4">
      <section className="space-y-2" aria-label="Mailbox discovery">
        <h2 className="text-sm font-semibold">Mailbox discovery</h2>
        <p className="max-w-prose text-xs text-muted-foreground">
          New mail is checked across senders. Historical coverage counts only
          the listed targeted searches; the rest of Gmail history has not been
          exhaustively scanned. A discovery poll is not proof that
          classification or import finished.
        </p>
        <RTable
          table={discoveryTable}
          ariaLabel="Mailbox discovery status"
          embedded
          withoutImages="Mailbox discovery has no record images."
        />
      </section>
      <section className="space-y-2" aria-label="Shared senders">
        <h2 className="text-sm font-semibold">Shared senders</h2>
        <p className="max-w-prose text-xs text-muted-foreground">
          Exact sender addresses observed in related mail on shared domains.
          Search completion covers that query, not every receipt or seller on
          the platform. Local counts overlap Vendor coverage; linked Emails may
          include lifecycle evidence.
        </p>
        <Tabs value={senderView} onValueChange={setSenderView}>
          <TabsList
            className="h-auto flex-wrap"
            aria-label="Shared sender views"
          >
            {[
              ["all", "All senders", senderRows.length],
              [
                "not_started",
                "Never searched",
                senderRows.filter((row) => row.state === "not_started").length,
              ],
              [
                "in_progress",
                "Incomplete",
                senderRows.filter((row) => row.state === "in_progress").length,
              ],
              [
                "complete",
                "Search complete",
                senderRows.filter((row) => row.state === "complete").length,
              ],
              [
                "unresolved",
                "Seller unresolved",
                senderRows.filter((row) => row.sellerUnresolved > 0).length,
              ],
            ].map(([value, label, count]) => (
              <TabsTrigger key={value} value={String(value)}>
                {label}{" "}
                <span className="font-mono text-muted-foreground">{count}</span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <RTable
          table={senderTable}
          showColumnMenu
          currentRowId={selectedSender ?? undefined}
          onRowClick={(row) => setSelectedSender(senderRowId(row.original))}
          disableMobileDetailsHref
          inspector={{
            title: inspectedSender?.sender ?? "Shared sender",
            onClose: () => setSelectedSender(null),
            content: inspectedSender ? (
              <SidePanel
                label="Shared sender inspector"
                title={inspectedSender.sender}
                eyebrow="Shared sender"
                onClose={() => setSelectedSender(null)}
                closeLabel="Close inspector"
              >
                <div className="p-4">
                  <SharedSenderDetails
                    vendors={coverageVendors(coverage)}
                    key={inspectedSender.sender}
                    sender={inspectedSender}
                    mailboxName={mailboxName}
                    onSaved={() => setSelectedSender(null)}
                  />
                </div>
              </SidePanel>
            ) : null,
          }}
          ariaLabel="Shared sender search coverage"
          emptyState={
            <p className="text-xs text-muted-foreground">
              {senderRows.length
                ? "No shared senders match this view. Clear search or choose All senders."
                : "No shared senders recorded in related mail yet."}
            </p>
          }
          embedded
          withoutImages="Senders are source identities, not Vendors."
        />
      </section>
      <section className="space-y-2" aria-label="Seller unresolved">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setUnresolvedOpen((open) => !open)}
          aria-expanded={unresolvedOpen}
        >
          Seller unresolved · {unresolvedTotal}
        </Button>
        {unresolvedOpen ? (
          <>
            <p className="text-xs text-muted-foreground">
              Related retained Emails with no attributed seller or accepted
              Purchase link. Showing {unresolvedRows.length} of{" "}
              {unresolvedTotal}; this list contains at most the latest 50 per
              connected mailbox.
            </p>
            <RTable
              table={unresolvedTable}
              ariaLabel="Emails with unresolved seller"
              emptyState={
                <p className="text-xs text-muted-foreground">
                  {unresolvedTotal > 0
                    ? "No originals are available in this sample. Refresh coverage to read the latest mailbox sample."
                    : "No retained related Emails are waiting for seller attribution."}
                </p>
              }
              embedded
              withoutImages="Open the original Email to inspect seller evidence."
            />
          </>
        ) : null}
      </section>
    </div>
  );
}
const states = {
  no_search_identity: "No search identity",
  not_started: "Not searched",
  in_progress: "Search incomplete",
  no_matches: "No matches",
  matches_found: "Matches found",
  complete: "Search complete",
} satisfies Record<MailCoverageRow["state"], string>;

const compactVisibility = {
  vendorAccountId: false,
  searches: false,
  classified: false,
  retained: false,
  linkedEmails: false,
  controlledImport: false,
};
const coverageViews = [
  ["all", "All coverage"],
  ["activity", "Running & queued"],
  ["never_searched", "Never searched"],
  ["incomplete", "Incomplete"],
  ["attention", "Needs attention"],
] satisfies [MailCoverageView, string][];
const inView = (row: MailCoverageRow, view: MailCoverageView) => {
  switch (view) {
    case "all":
      return true;
    case "activity":
      return row.queue.state === "running" || row.queue.state === "queued";
    case "never_searched":
      return row.state === "not_started";
    case "incomplete":
      return row.searchesTotal > row.searchesCompleted;
    case "attention":
      return (
        row.state === "no_search_identity" ||
        row.queue.state === "paused" ||
        (row.controlledRun !== null &&
          (row.controlledRun.imports.failed > 0 ||
            row.controlledRun.imports.needsReview > 0 ||
            ["failed", "dispatch_failed", "paused_auth"].includes(
              row.controlledRun.status,
            )))
      );
  }
};
function QueueCell({ row }: { row: MailCoverageRow }) {
  const label =
    row.queue.state === "running"
      ? "Running now"
      : row.queue.state === "queued"
        ? `Next · #${row.queue.position ?? 1}`
        : row.queue.state === "paused"
          ? "Paused"
          : "—";
  return (
    <span
      className="flex items-center gap-1"
      title={row.queue.reason ?? undefined}
    >
      <StatusText
        tone={
          row.queue.state === "running"
            ? "positive"
            : row.queue.state === "paused"
              ? "warning"
              : "muted"
        }
      >
        {label}
      </StatusText>
      {row.queue.runId ? (
        <EntityRefLink entity="run" id={row.queue.runId} />
      ) : null}
    </span>
  );
}
function CoverageCountLink({
  row,
  stage,
  children,
}: {
  row: MailCoverageRow;
  stage: "known" | "classified" | "retained" | "linked";
  children: ReactNode;
}) {
  return (
    <Link
      to="/emails"
      search={{
        coverageVendorId: row.vendorId,
        coverageStage: stage,
        mailboxId: row.mailboxId,
        ledgerPartyId: row.memberId,
      }}
      className="font-mono tabular-nums underline-offset-2 hover:underline"
      onClick={(event) => event.stopPropagation()}
    >
      {children}
    </Link>
  );
}
function PurchaseCountCell({ row }: { row: MailCoverageRow }) {
  if (!row.linkedPurchases) return <StatusText>0</StatusText>;
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="link"
            size="sm"
            className="px-1 font-mono tabular-nums"
          />
        }
        onClick={(event) => event.stopPropagation()}
        aria-label={`Linked Purchases for ${row.vendorName}`}
      >
        {row.linkedPurchases}
      </PopoverTrigger>
      <PopoverContent
        className="max-h-96 w-80 space-y-2 overflow-y-auto"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 className="text-sm font-semibold">Linked Purchases</h3>
        <p className="text-xs text-muted-foreground">
          Distinct Purchases linked to this Vendor’s Emails in this mailbox.
        </p>
        <ul className="space-y-2">
          {row.linkedPurchaseIds.map((id) => (
            <li key={id}>
              <EntityRefLink entity="purchase" id={id} />
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

function SearchCoverageCell({ row }: { row: MailCoverageRow }) {
  const tone =
    row.searchesTotal === 0
      ? "muted"
      : row.searchesCompleted === row.searchesTotal
        ? "positive"
        : "warning";
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className="px-1 font-mono tabular-nums"
          />
        }
        aria-label={`Search coverage for ${row.vendorName}: ${row.searchesCompleted} of ${row.searchesTotal} complete`}
        onClick={(event) => event.stopPropagation()}
      >
        <StatusText tone={tone}>
          {row.searchesCompleted}/{row.searchesTotal}
        </StatusText>
      </PopoverTrigger>
      <PopoverContent
        className="w-96 max-w-[calc(100vw-2rem)] space-y-3"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 className="text-sm font-semibold">Search coverage</h3>
        <p className="text-xs text-muted-foreground">
          Completed full-history Gmail queries for this Vendor’s current domains
          and verified senders. This counts query definitions, not Emails or
          import Runs.
        </p>
        {row.searches.length ? (
          <ul className="space-y-3">
            {row.searches.map((search) => (
              <li key={search.query} className="space-y-1">
                <code className="block text-xs break-words">
                  {search.query}
                </code>
                <Badge
                  variant={
                    search.state === "complete"
                      ? "positive"
                      : search.state === "in_progress"
                        ? "warning"
                        : "secondary"
                  }
                >
                  {search.state === "complete"
                    ? "Complete"
                    : search.state === "in_progress"
                      ? "Incomplete"
                      : "Not searched"}
                </Badge>
                {search.queuePosition !== null ? (
                  <p className="text-xs">
                    Mailbox queue #{search.queuePosition}
                  </p>
                ) : null}
                {search.runId ? (
                  <EntityRefLink entity="run" id={search.runId} />
                ) : search.state !== "not_started" ? (
                  <p className="text-xs text-muted-foreground">
                    Run not recorded
                  </p>
                ) : null}
                {search.completedAt ? (
                  <DateDisplay timestamp={search.completedAt} />
                ) : search.state === "complete" ? (
                  <p className="text-xs text-muted-foreground">
                    Completion time not recorded
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs">
            Add a website or verified sender to the Vendor to enable searches.
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          Existing Emails can come from earlier or manual imports. Date-limited
          runs are shown under Controlled import.
        </p>
      </PopoverContent>
    </Popover>
  );
}

function LinkedEmailCell({ row }: { row: MailCoverageRow }) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="link"
            size="sm"
            className="px-1 font-mono tabular-nums"
          />
        }
        aria-label={`Linked Emails for ${row.vendorName}: ${row.linkedEmails}`}
        onClick={(event) => event.stopPropagation()}
      >
        {row.linkedEmails === 0 ? <StatusText>0</StatusText> : row.linkedEmails}
      </PopoverTrigger>
      <PopoverContent
        className="w-80 max-w-[calc(100vw-2rem)] space-y-2 text-sm"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 className="font-semibold">Emails linked to Purchases</h3>
        <CoverageCountLink row={row} stage="linked">
          Open {row.linkedEmails} linked Emails
        </CoverageCountLink>
        <p>
          {countLabel(row.linkedRetainedEmails, "Email")} with content saved
        </p>
        <p>
          {countLabel(row.linkedEmails - row.linkedRetainedEmails, "Email")}{" "}
          with metadata only
        </p>
        <p className="text-xs text-muted-foreground">
          An Email’s Purchase link remains if its original content is cleared.
          Content saved counts currently retained originals; it is not a
          required step before an Email can stay linked.
        </p>
      </PopoverContent>
    </Popover>
  );
}

function controlledStatus(row: MailCoverageRow): string {
  const control = row.controlledRun;
  if (!control) return "Not requested";
  if (control.queued) return "Waiting for active work";
  if (control.imports.running > 0) return "Importing";
  if (control.imports.paused > 0) return "Import paused";
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
          controlled.imports.paused
            ? `${countLabel(controlled.imports.paused, "import")} paused`
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
  return {
    from: "",
    to: householdLocalDate(),
    previewEnabled: false,
    revision: 0,
  };
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
      row.controlledRun.imports.running > 0 ||
      row.controlledRun.imports.paused > 0);
  const canControl =
    mailbox.canControl && row.searchesTotal > 0 && !alreadyRunning;
  return (
    <section
      className="min-w-0 space-y-3 border-t py-4"
      aria-label="Controlled import"
    >
      <h2 className="text-base font-semibold">Import selected Vendor</h2>
      <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
        <span className="max-w-full min-w-0 overflow-hidden">
          <EntityRefLink
            entity="vendor"
            id={row.vendorId}
            name={row.vendorName}
          />
        </span>
        <span className="min-w-0 break-words">{mailbox.label}</span>
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
        Runs next after active work finishes. Other imports stay paused until
        you resume this mailbox. Paid AI uses the household budget.
      </p>
      {!mailbox.canControl ? (
        <StatusText>
          Only the connected mailbox member can control this import.
        </StatusText>
      ) : null}
      {row.queue.reason ? (
        <p className="text-xs text-muted-foreground">{row.queue.reason}</p>
      ) : null}
      {row.queue.runId ? (
        <p className="flex flex-wrap items-center gap-2 text-xs">
          Current work <EntityRefLink entity="run" id={row.queue.runId} />
        </p>
      ) : null}
      {row.searchesTotal === 0 ? (
        <StatusText>
          Add a sender or domain to{" "}
          <EntityRefLink
            entity="vendor"
            id={row.vendorId}
            name={row.vendorName}
          />{" "}
          before searching.
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
      <DateRangeShortcuts
        allLabel="All history"
        disabled={!canPreview || control.isPending}
        onSelect={(bounds) =>
          onDraftChange({
            ...draft,
            from: bounds.dateFrom ?? "",
            to: bounds.dateTo ?? "",
            revision: draft.revision + 1,
          })
        }
      />
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
            key={`from-${draft.revision}`}
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
            key={`to-${draft.revision}`}
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
        Leave From blank for earlier history; Through starts today. Type “1 year
        ago” or “today”, then press Enter or leave the field.
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
          {control.isPending ? "Starting import…" : "Import next"}
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
  view = "all",
  onViewChange,
}: {
  coverage: MailCoverage;
  vendorId?: string;
  mailboxId?: string;
  accountId?: string;
  view?: MailCoverageView;
  onViewChange?: (view: MailCoverageView) => void;
}) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [selectedAddress, setSelectedAddress] = useState<string | null>(null);
  // Responsive inspectors move between containers; the selection owner retains its draft.
  const [draft, setDraft] = useState(initialControlledMailDraft);
  const contextRows = useMemo(
    () =>
      coverage.rows.filter(
        (row) =>
          (!vendorId || row.vendorId === vendorId) &&
          (!accountId || row.vendorAccountId === accountId) &&
          (!mailboxId || row.mailboxId === mailboxId),
      ),
    [coverage.rows, vendorId, mailboxId, accountId],
  );
  const rows = useMemo(
    () => contextRows.filter((row) => inView(row, view)),
    [contextRows, view],
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
          ...row.domains,
          ...row.senderAddresses,
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
          helper.accessor((row) => row.domains.join(", "), {
            id: "domains",
            header: "Domains",
            size: 220,
          }),
        );
        add(
          helper.accessor((row) => row.senderAddresses.join(", "), {
            id: "senderAddresses",
            header: "Sender addresses",
            size: 280,
            cell: ({ row }) => (
              <span data-cell-value>
                {row.original.senderAddresses.map((address) => (
                  <Button
                    key={address}
                    variant="ghost"
                    size="sm"
                    onClick={(event) => {
                      event.stopPropagation();
                      setSelectedKey(row.original.key);
                      setSelectedAddress(address);
                    }}
                  >
                    {address}
                  </Button>
                ))}
              </span>
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
            cell: ({ row, getValue }) => {
              const id = getValue();
              return id ? (
                <EntityRefLink
                  entity="vendorAccount"
                  id={id}
                  name={row.original.vendorAccountName}
                />
              ) : (
                <span className="text-muted-foreground">None</span>
              );
            },
          }),
        );
        add(
          helper.accessor(
            (row) =>
              row.queue.state === "running"
                ? 0
                : row.queue.state === "queued"
                  ? (row.queue.position ?? 1)
                  : row.queue.state === "paused"
                    ? 1_000_000 + (row.queue.position ?? 0)
                    : 2_000_000,
            {
              id: "queue",
              header: "Queue",
              size: 180,
              meta: attachCubbyColumnMeta<MailCoverageRow>({
                mobile: { slot: "meta", priority: 1 },
              }),
              cell: ({ row }) => <QueueCell row={row.original} />,
            },
          ),
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
                    ? "warning"
                    : getValue() === "no_search_identity"
                      ? "warning"
                      : getValue() === "complete" ||
                          getValue() === "matches_found" ||
                          getValue() === "no_matches"
                        ? "positive"
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
              header: "Search coverage",
              size: 140,
              cell: ({ row }) => <SearchCoverageCell row={row.original} />,
            },
          ),
        );
        for (const [key, label] of [
          ["scanned", "Known Emails"],
          ["classified", "Classified Emails"],
          ["retained", "Content saved"],
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
              cell: ({ row, getValue }) => {
                if (key === "linkedPurchases")
                  return <PurchaseCountCell row={row.original} />;
                if (key === "linkedEmails")
                  return <LinkedEmailCell row={row.original} />;
                const value = getValue();
                const remaining =
                  row.original.scanned - row.original.classified;
                const tone =
                  value === 0
                    ? "muted"
                    : key === "classified"
                      ? remaining > 0
                        ? "warning"
                        : "positive"
                      : null;
                return (
                  <CoverageCountLink
                    row={row.original}
                    stage={
                      key === "scanned"
                        ? "known"
                        : key === "classified"
                          ? "classified"
                          : "retained"
                    }
                  >
                    {tone ? (
                      <StatusText
                        tone={tone}
                        className="font-mono tabular-nums"
                        title={
                          key === "classified" && remaining > 0
                            ? `${remaining} Emails have no recorded classification`
                            : undefined
                        }
                      >
                        {value}
                        {key === "classified" && remaining > 0 ? (
                          <span className="sr-only">
                            {" "}
                            of {row.original.scanned}; {remaining} await
                            classification
                          </span>
                        ) : null}
                      </StatusText>
                    ) : (
                      <span className="font-mono tabular-nums">{value}</span>
                    )}
                  </CoverageCountLink>
                );
              },
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
                <span title="Latest completion among this Vendor’s current full-history queries. New-mail checks and imports are separate.">
                  <DateDisplay timestamp={timestamp} />
                </span>
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
  const table = useLocalTable({
    rows,
    columns,
    getRowId: rowId,
    search,
    initialVisibility: compactVisibility,
    rowContentVersion: rows,
  });
  const selected = coverage.rows.find((row) => row.key === selectedKey);
  const mailbox = selected ? mailboxes.get(selected.mailboxId) : undefined;
  return (
    <Tabs
      value={view}
      onValueChange={(value) => {
        const next = coverageViews.find(([key]) => key === value)?.[0];
        if (next) onViewChange?.(next);
      }}
    >
      {vendorId || mailboxId || accountId ? (
        <p className="text-xs text-muted-foreground">
          Showing linked record context.{" "}
          <Link to="/emails/coverage" search={{}} className="underline">
            Show all Vendors and mailboxes
          </Link>
        </p>
      ) : null}
      {onViewChange ? (
        <TabsList className="h-auto flex-wrap" aria-label="Mail coverage views">
          {coverageViews.map(([key, label]) => (
            <TabsTrigger key={key} value={key}>
              {label}{" "}
              <span className="font-mono text-muted-foreground">
                {contextRows.filter((row) => inView(row, key)).length}
              </span>
            </TabsTrigger>
          ))}
        </TabsList>
      ) : null}
      <TabsContent value={view} keepMounted>
        <RTable
          table={table}
          ariaLabel="Mail coverage by Vendor and mailbox"
          embedded
          showColumnMenu
          withoutImages="Coverage rows use canonical Vendor links."
          currentRowId={selectedKey ?? undefined}
          onRowClick={(row) => {
            if (row.original.key !== selectedKey)
              setDraft(initialControlledMailDraft());
            setSelectedKey(row.original.key);
            setSelectedAddress(null);
          }}
          disableMobileDetailsHref
          inspector={{
            title: selectedAddress ?? "Controlled mail import",
            onClose: () => {
              setSelectedKey(null);
              setSelectedAddress(null);
            },
            content:
              selected && mailbox ? (
                <SidePanel
                  label="Vendor mail inspector"
                  title={selectedAddress ?? selected.vendorName}
                  onClose={() => {
                    setSelectedKey(null);
                    setSelectedAddress(null);
                  }}
                  closeLabel="Close inspector"
                >
                  <div className="space-y-4 p-4">
                    {selectedAddress ? (
                      <SenderAttributionDetails
                        vendors={coverageVendors(coverage)}
                        key={selectedAddress}
                        attribution={
                          coverage.senderAttributions.find(
                            (row) => row.sender === selectedAddress,
                          ) ??
                          senderAttributionSchema.parse({
                            sender: selectedAddress,
                            state: "unmapped",
                            origin: null,
                            vendorId: null,
                            vendors: [],
                            evidenceCount: 0,
                            evidence: [],
                          })
                        }
                        onSaved={() => {
                          setSelectedKey(null);
                          setSelectedAddress(null);
                        }}
                      />
                    ) : (
                      <>
                        <p className="text-xs break-words">
                          Domains: {selected.domains.join(", ") || "None"}
                        </p>
                        <div className="flex flex-wrap gap-1">
                          {selected.senderAddresses.map((address) => (
                            <Button
                              key={address}
                              size="sm"
                              variant="outline"
                              onClick={() => setSelectedAddress(address)}
                            >
                              {address}
                            </Button>
                          ))}
                        </div>
                        <ControlledMailImport
                          key={selected.key}
                          row={selected}
                          mailbox={mailbox}
                          draft={draft}
                          onDraftChange={setDraft}
                        />
                      </>
                    )}
                  </div>
                </SidePanel>
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
      </TabsContent>
    </Tabs>
  );
}

export function MailCoveragePage({
  vendorId,
  mailboxId,
  accountId,
  view = "all",
  onViewChange,
}: {
  vendorId?: string;
  mailboxId?: string;
  accountId?: string;
  view?: MailCoverageView;
  onViewChange?: (view: MailCoverageView) => void;
}) {
  const query = useQuery({
    ...run.mailCoverage.queryOptions({}),
    refetchInterval: (current) =>
      current.state.data?.mailboxes.some((mailbox) => mailbox.enabled) ||
      current.state.data?.discovery.some(
        (row) => row.runStatus !== null && activeRunStatuses.has(row.runStatus),
      ) ||
      current.state.data?.rows.some(
        (row) =>
          row.queue.state === "running" ||
          row.queue.state === "queued" ||
          row.state === "in_progress" ||
          (row.controlledRun !== null &&
            (activeRunStatuses.has(row.controlledRun.status) ||
              row.controlledRun.imports.running > 0 ||
              row.controlledRun.imports.paused > 0)),
      )
        ? 30_000
        : false,
  });
  const loading = useHydratedLoading(query.isPending);
  return (
    <div className="min-w-0 space-y-3">
      <p className="text-xs text-muted-foreground">
        Track coverage and upcoming work in each mailbox. Select a Vendor to
        preview Gmail matches or import next.
      </p>
      <details className="text-xs text-muted-foreground">
        <summary>How coverage and counts work</summary>
        <p className="max-w-prose text-xs text-muted-foreground">
          Every Vendor appears once per connected mailbox, including Vendors
          with no mail. Select a row to import that Vendor. Counts cover local
          sender/domain candidates or attributed evidence, not Gmail totals. A
          matching domain does not establish Vendor attribution. Linked
          Purchases are distinct records. Search completion does not mean all
          purchases were imported; follow the controlled import Run for its
          outcome. Counts cover recorded history; import dates do not filter
          this table.
        </p>
        <p className="mt-2 max-w-prose">
          Queue positions belong to each mailbox and include unmatched-charge
          searches. New-mail checks can run between searches. Last searched
          records historical query completion; new mail may have arrived since
          then.
        </p>
      </details>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Button
          variant="ghost"
          size="sm"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          {query.isFetching ? "Refreshing…" : "Refresh coverage"}
        </Button>
        {query.dataUpdatedAt ? (
          <span className="text-muted-foreground">
            Updated{" "}
            <DateDisplay
              timestamp={new Date(query.dataUpdatedAt).toISOString()}
            />
          </span>
        ) : null}
      </div>
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
        <>
          {!vendorId && !accountId ? (
            <DiscoveryCoverage coverage={query.data} mailboxId={mailboxId} />
          ) : null}
          <h2 className="text-sm font-semibold">Vendor coverage</h2>
          <CoverageTable
            coverage={query.data}
            vendorId={vendorId}
            mailboxId={mailboxId}
            accountId={accountId}
            view={view}
            onViewChange={onViewChange}
          />
        </>
      ) : null}
    </div>
  );
}
