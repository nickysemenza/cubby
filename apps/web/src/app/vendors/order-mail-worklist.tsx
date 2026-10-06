import {
  ledgerPartyShortcode,
  vendorShortcode,
} from "@cubby/schemas/identifiers";
import type {
  VendorOrderMailOut,
  VendorSearchMailOut,
} from "@cubby/schemas/order-mail-review";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import type { DetailSlotComponent } from "~/entity/entity-detail/detail-slots";
import { vendor } from "~/integrations/tanstack-query/generated/catalog.gen";
import { formatInstant } from "~/lib/date-format";
import { getErrorMessage } from "~/lib/error-utils";
import { formatCurrency } from "~/lib/utils";
import { useActionMutation } from "~/ui/hooks/useActionMutation";
import { Row, Stack } from "~/ui/layout";
import { Badge } from "~/ui/primitives/badge";
import { Button } from "~/ui/primitives/button";
import { Checkbox } from "~/ui/primitives/checkbox";
import { NativeSelect } from "~/ui/primitives/native-select";
import { StatusText } from "~/ui/primitives/status-text";
import { TechnicalError } from "~/ui/primitives/technical-error";

type MailItem = VendorOrderMailOut["items"][number];
type MailEvent = MailItem["events"][number];
type MailCandidate = MailEvent["candidates"][number];
type MailSelection = Map<
  string,
  { evidenceChecksum: string; ledgerPartyId: string }
>;

export const gmailThreadUrl = (threadId: string) =>
  `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(threadId)}`;

const matchEvidence = (candidate: MailCandidate) => {
  switch (candidate.reason) {
    case "exact_order_id":
      return {
        label: "Strong match",
        explanation: "Exact order ID",
        tone: "positive",
        rank: 0,
      } as const;
    case "previous_decision":
      return {
        label: "Reviewed",
        explanation: "Previous decision",
        tone: "secondary",
        rank: 1,
      } as const;
    case "amount_and_date":
      return {
        label: "Possible match",
        explanation: "Amount and date match",
        tone: "secondary",
        rank: 2,
      } as const;
    case "nearby_date":
      return {
        label: "Weak lead",
        explanation: "Date only",
        tone: "outline",
        rank: 3,
      } as const;
  }
};

type OrderStep = { mail: MailItem; event: MailEvent | null; at: string };
type OrderGroup = {
  key: string;
  orderId: string | null;
  ledgerPartyId: string;
  steps: OrderStep[];
};

/**
 * One row per order. A vendor sends placed, shipped, and delivered mail for
 * the same order; each names the same Purchase, so they read as one timeline.
 */
function groupByOrder(items: readonly MailItem[]): OrderGroup[] {
  const groups = new Map<string, OrderGroup>();
  for (const mail of items)
    for (const event of mail.events.length > 0 ? mail.events : [null]) {
      const key = event?.orderId
        ? `${mail.ledgerPartyId}|${event.orderId}`
        : `${mail.messageId}|${event?.id ?? ""}`;
      const group = groups.get(key) ?? {
        key,
        orderId: event?.orderId ?? null,
        ledgerPartyId: mail.ledgerPartyId,
        steps: [],
      };
      group.steps.push({
        mail,
        event,
        at: event?.occurredAt ?? mail.receivedAt,
      });
      groups.set(key, group);
    }
  for (const group of groups.values())
    group.steps.sort((left, right) => left.at.localeCompare(right.at));
  return [...groups.values()];
}

type OrderCandidate = {
  candidate: MailCandidate;
  /** Every email in the order, with its decision for this Purchase. */
  events: Array<{ event: MailEvent; decision: MailCandidate["decision"] }>;
  /** Shared decision; `null` when undecided or the emails disagree. */
  decision: MailCandidate["decision"];
};

function orderCandidates(steps: readonly OrderStep[]): OrderCandidate[] {
  const events = steps.flatMap(({ event }) => (event ? [event] : []));
  const strongest = new Map<string, MailCandidate>();
  for (const event of events)
    for (const candidate of event.candidates) {
      const current = strongest.get(candidate.purchaseId);
      if (
        !current ||
        matchEvidence(candidate).rank < matchEvidence(current).rank
      )
        strongest.set(candidate.purchaseId, candidate);
    }
  // A decision covers every email in the order, including one whose own
  // candidate window missed this Purchase (a late shipment notice); it counts
  // as undecided until written.
  return [...strongest.values()].map((candidate) => {
    const decisions = events.map((event) => ({
      event,
      decision:
        event.candidates.find(
          (other) => other.purchaseId === candidate.purchaseId,
        )?.decision ?? null,
    }));
    const [first] = decisions;
    return {
      candidate,
      events: decisions,
      decision:
        first && decisions.every(({ decision }) => decision === first.decision)
          ? first.decision
          : null,
    };
  });
}

const canImport = (event: MailEvent | null): event is MailEvent =>
  event?.event === "placed" &&
  Boolean(event.orderId) &&
  !event.candidates.some(
    (candidate) =>
      candidate.reason === "exact_order_id" || candidate.decision === "linked",
  );

function OrderMailRow({
  group,
  selection,
  onSelect,
}: {
  group: OrderGroup;
  selection: MailSelection;
  onSelect: (event: MailEvent, checked: boolean) => void;
}) {
  const importOrder = useActionMutation({
    mutationFn: vendor.importOrderMail.mutationOptions,
    success: "Order import started",
  });
  const decide = useActionMutation({
    mutationFn: vendor.decideOrderMail.mutationOptions,
    success: "Order email match reviewed",
    // One decision writes every email in the order; toast it once.
    successToastId: `order-mail-decision:${group.key}`,
  });
  const importable = group.steps.map((step) => step.event).find(canImport);
  const amount =
    group.steps.find((step) => step.event?.event === "placed")?.event?.amount ??
    group.steps.find((step) => step.event?.amount != null)?.event?.amount ??
    null;
  const candidates = orderCandidates(group.steps);
  // `decide.isPending` tracks only the latest call; a group decision is
  // several, so hold every button until the whole batch settles.
  const [deciding, setDeciding] = useState(false);
  const decideAll = async (
    { candidate, events }: OrderCandidate,
    decision: "linked" | "dismissed",
  ) => {
    setDeciding(true);
    await Promise.allSettled(
      events
        .filter((entry) => entry.decision !== decision)
        .map(({ event }) =>
          decide.mutateAsync({
            eventId: event.id,
            purchaseId: candidate.purchaseId,
            decision,
            evidenceChecksum: event.evidenceChecksum,
          }),
        ),
    );
    setDeciding(false);
  };
  const mails = [
    ...new Map(group.steps.map(({ mail }) => [mail.messageId, mail])).values(),
  ];
  return (
    <article className="px-3 py-2 text-sm">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span
          className="shrink-0 truncate font-mono font-medium sm:w-40"
          title={group.orderId ?? undefined}
        >
          {group.orderId ?? "Order unknown"}
        </span>
        <ol className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-4 gap-y-0.5">
          {group.steps.map(({ mail, event, at }) => (
            <li
              key={`${mail.messageId}|${event?.id ?? ""}`}
              className="flex max-w-full min-w-0 items-baseline gap-1.5"
            >
              <span className="shrink-0 text-xs font-medium">
                {!event || event.event === "other" ? "update" : event.event}
              </span>
              <span
                className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums"
                title={formatInstant(at, "dateTime")}
              >
                {formatInstant(at, "monthDay")}
              </span>
              {mail.threadId ? (
                <a
                  className="max-w-64 min-w-0 truncate text-muted-foreground hover:text-foreground hover:underline"
                  href={gmailThreadUrl(mail.threadId)}
                  target="_blank"
                  rel="noreferrer"
                  title={`Open Gmail conversation · ${mail.sender}`}
                >
                  {mail.subject}
                </a>
              ) : (
                <span
                  className="max-w-64 min-w-0 truncate text-muted-foreground"
                  title={mail.sender}
                >
                  {mail.subject}
                </span>
              )}
            </li>
          ))}
        </ol>
        {amount !== null ? (
          <span className="ml-auto font-mono tabular-nums">
            {formatCurrency(amount)}
          </span>
        ) : null}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 sm:pl-43">
        {importable && !importOrder.data ? (
          <div className="flex items-center gap-1.5">
            <Checkbox
              aria-label={`Select order ${importable.orderId} to import with others`}
              checked={selection.has(importable.id)}
              // One run covers one member's mail.
              disabled={[...selection.values()].some(
                (picked) => picked.ledgerPartyId !== group.ledgerPartyId,
              )}
              onCheckedChange={(checked) =>
                onSelect(importable, checked === true)
              }
            />
            <Button
              size="xs"
              variant="outline"
              disabled={importOrder.isPending}
              title="The agent reads the saved confirmation and imports its itemized order."
              onClick={() =>
                importOrder.mutate({
                  eventId: importable.id,
                  evidenceChecksum: importable.evidenceChecksum,
                })
              }
            >
              {importOrder.isPending ? "Starting import…" : "Import order"}
            </Button>
          </div>
        ) : null}
        {importOrder.data ? (
          <Link
            to="/runs/$shortcode"
            params={{ shortcode: importOrder.data.runId }}
            className="text-xs text-primary underline underline-offset-4"
          >
            View import
          </Link>
        ) : null}
        {candidates.length === 0 ? (
          <span className="text-xs text-muted-foreground">
            No Purchase match
          </span>
        ) : (
          candidates.map((entry) => {
            const { candidate, decision } = entry;
            const evidence = matchEvidence(candidate);
            return (
              <div
                key={candidate.purchaseId}
                className="flex items-center gap-1 rounded-md bg-muted/50 py-0.5 ps-2 pe-0.5"
              >
                <div className="flex min-w-0 items-center gap-1.5">
                  <a
                    className="font-medium text-primary hover:underline"
                    href={`/purchases/${candidate.purchaseId}`}
                  >
                    {candidate.orderId ?? candidate.purchaseId}
                  </a>
                  <Badge variant={evidence.tone}>{evidence.label}</Badge>
                  <span className="text-xs text-muted-foreground">
                    {evidence.explanation}
                  </span>
                  {decision ? (
                    <Badge variant="secondary">{decision}</Badge>
                  ) : null}
                </div>
                <div className="flex">
                  {decision !== "linked" ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={deciding}
                      onClick={() => void decideAll(entry, "linked")}
                    >
                      Link
                    </Button>
                  ) : null}
                  {decision !== "dismissed" ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={deciding}
                      onClick={() => void decideAll(entry, "dismissed")}
                    >
                      Dismiss
                    </Button>
                  ) : null}
                </div>
              </div>
            );
          })
        )}
        <details className="ml-auto text-xs text-muted-foreground [&[open]]:basis-full">
          <summary className="cursor-pointer">Technical details</summary>
          {mails.map((mail) => (
            <div key={mail.messageId} className="font-mono">
              Message ID: {mail.messageId}
              {mail.threadId ? ` · Thread ID: ${mail.threadId}` : null}
            </div>
          ))}
        </details>
      </div>
      {importOrder.error ? (
        <TechnicalError error={getErrorMessage(importOrder.error)} />
      ) : null}
    </article>
  );
}

// oxlint-disable-next-line eslint/complexity -- The worklist renders independent search, review, and empty states in one detail section.
function OrderMailWorklist({
  vendorId,
  ledgerPartyId,
  canSearch = false,
  hasSearchTerms = false,
}: {
  vendorId: string;
  ledgerPartyId?: string;
  canSearch?: boolean;
  hasSearchTerms?: boolean;
}) {
  const [memberFilter, setMemberFilter] = useState(ledgerPartyId ?? "");
  const [searchPage, setSearchPage] = useState<VendorSearchMailOut | null>(
    null,
  );
  const [selection, setSelection] = useState<MailSelection>(new Map());
  const importSelected = useActionMutation({
    mutationFn: vendor.importSelectedOrderMail.mutationOptions,
    success: "Order import started",
    onSuccess: () => setSelection(new Map()),
  });
  const worklist = useQuery(
    vendor.orderMail.queryOptions({
      vendorId: vendorShortcode.parse(vendorId),
      ledgerPartyId: memberFilter
        ? ledgerPartyShortcode.parse(memberFilter)
        : null,
    }),
  );
  const { refetch: refetchWorklist } = worklist;
  const jobStatus = useQuery({
    ...vendor.orderMailSearchStatus.queryOptions({
      vendorId: vendorShortcode.parse(vendorId),
    }),
    enabled: canSearch,
    refetchInterval: (query) =>
      query.state.data?.status === "queued" ||
      query.state.data?.status === "running" ||
      query.state.data?.status === "waiting"
        ? 2_000
        : false,
  });
  const search = useActionMutation({
    mutationFn: vendor.searchOrderMail.mutationOptions,
    error: "Gmail search failed",
    onSuccess: (result) => {
      setSearchPage(result);
      void jobStatus.refetch();
    },
  });
  const savedJob = jobStatus.data;
  const currentJob =
    savedJob && (!searchPage || savedJob.createdAt >= searchPage.createdAt)
      ? savedJob
      : searchPage;
  const jobActive =
    currentJob?.status === "queued" ||
    currentJob?.status === "running" ||
    currentJob?.status === "waiting";
  const completedPage = currentJob?.status === "completed" ? currentJob : null;
  const resumablePage =
    currentJob?.status === "failed" && currentJob.nextPageToken
      ? currentJob
      : null;
  useEffect(() => {
    if (jobStatus.data?.status === "completed") void refetchWorklist();
  }, [jobStatus.data?.createdAt, jobStatus.data?.status, refetchWorklist]);
  if (worklist.isPending) return <StatusText>Loading order email…</StatusText>;
  if (worklist.isError)
    return <StatusText tone="destructive">{worklist.error.message}</StatusText>;
  return (
    <Stack gap="md">
      {canSearch ? (
        <Stack gap="sm">
          <Row align="center" gap="sm" className="flex-wrap">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={search.isPending || jobActive || !hasSearchTerms}
              onClick={() => {
                search.mutate({
                  vendorId: vendorShortcode.parse(vendorId),
                  after: resumablePage?.after,
                  pageToken: resumablePage?.nextPageToken ?? undefined,
                });
              }}
            >
              {search.isPending || jobActive
                ? "Searching Gmail…"
                : resumablePage
                  ? "Resume Gmail search"
                  : "Search Gmail now"}
            </Button>
            {completedPage?.nextPageToken ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={search.isPending}
                onClick={() =>
                  search.mutate({
                    vendorId: vendorShortcode.parse(vendorId),
                    after: completedPage.after,
                    pageToken: completedPage.nextPageToken ?? undefined,
                  })
                }
              >
                Continue unfinished search
              </Button>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={search.isPending || jobActive || !hasSearchTerms}
              onClick={() =>
                search.mutate({
                  vendorId: vendorShortcode.parse(vendorId),
                  after: "1970/01/01",
                })
              }
            >
              Search all history
            </Button>
            <span className="text-xs text-muted-foreground">
              {hasSearchTerms
                ? "Search all matching email since the date shown in the Run, using this Vendor’s website domain and known senders. Saved order evidence appears below."
                : "Add a website to this Vendor to search Gmail."}
            </span>
          </Row>
          {currentJob ? (
            <div aria-live="polite" className="text-xs text-muted-foreground">
              <Link
                to="/runs/$shortcode"
                params={{ shortcode: currentJob.runShortcode }}
                className="mr-2 font-medium text-primary hover:underline"
              >
                View run
              </Link>
              {currentJob.status === "waiting" ? (
                <div>
                  <span>Rate limited. This page will retry shortly.</span>
                  {currentJob.error ? (
                    <TechnicalError error={currentJob.error} tone="muted" />
                  ) : null}
                </div>
              ) : null}
              {currentJob.status === "queued" || currentJob.status === "running"
                ? "Scanning Gmail. You can leave this page and return."
                : null}
              {currentJob.status === "completed" ? (
                <span>
                  Checked {currentJob.searched} messages; {currentJob.skipped}{" "}
                  already saved. {currentJob.reviewable} order email
                  {currentJob.reviewable === 1 ? "" : "s"} to review.
                </span>
              ) : null}
              {currentJob.status === "failed" ? (
                <div>
                  <TechnicalError
                    error={currentJob.error ?? "Search stopped"}
                    prefix="Search stopped: "
                  />
                  <span className="text-muted-foreground">
                    {resumablePage
                      ? "Resume from the last completed page."
                      : "Search Gmail again to retry."}
                  </span>
                </div>
              ) : null}
            </div>
          ) : null}
        </Stack>
      ) : null}
      {!ledgerPartyId && worklist.data.members.length > 1 ? (
        <NativeSelect
          aria-label="Filter order email by member"
          value={memberFilter}
          onChange={(event) => setMemberFilter(event.target.value)}
          className="max-w-56"
        >
          <option value="">All members</option>
          {worklist.data.members.map((member) => (
            <option key={member.id} value={member.id}>
              {member.name}
            </option>
          ))}
        </NativeSelect>
      ) : null}
      {selection.size > 0 || importSelected.data || importSelected.error ? (
        <Stack gap="sm" aria-live="polite">
          <Row align="center" gap="sm" className="flex-wrap">
            {selection.size > 0 ? (
              <>
                <Button
                  type="button"
                  size="sm"
                  disabled={importSelected.isPending}
                  onClick={() =>
                    importSelected.mutate({
                      orders: [...selection].map(
                        ([eventId, { evidenceChecksum }]) => ({
                          eventId,
                          evidenceChecksum,
                        }),
                      ),
                    })
                  }
                >
                  {importSelected.isPending
                    ? "Starting import…"
                    : `Import selected (${selection.size})`}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setSelection(new Map())}
                >
                  Clear selection
                </Button>
              </>
            ) : null}
            {importSelected.data ? (
              <Link
                to="/runs/$shortcode"
                params={{ shortcode: importSelected.data.runId }}
                className="text-primary underline underline-offset-4"
              >
                View selected import
              </Link>
            ) : null}
          </Row>
          {importSelected.error ? (
            <TechnicalError error={getErrorMessage(importSelected.error)} />
          ) : null}
        </Stack>
      ) : null}
      {worklist.data.items.length === 0 ? (
        <StatusText>
          {jobActive
            ? "Searching for order email. Matches will appear when the job finishes."
            : "No order email has been matched to this Vendor."}
        </StatusText>
      ) : (
        <div className="divide-y divide-border rounded-lg border border-border bg-card">
          {groupByOrder(worklist.data.items).map((group) => (
            <OrderMailRow
              key={group.key}
              group={group}
              selection={selection}
              onSelect={(event, checked) =>
                setSelection((current) => {
                  const next = new Map(current);
                  if (checked)
                    next.set(event.id, {
                      evidenceChecksum: event.evidenceChecksum,
                      ledgerPartyId: group.ledgerPartyId,
                    });
                  else next.delete(event.id);
                  return next;
                })
              }
            />
          ))}
        </div>
      )}
    </Stack>
  );
}

export const VendorOrderMail: DetailSlotComponent<"vendor"> = ({ record }) => (
  <OrderMailWorklist
    vendorId={record.id}
    canSearch
    hasSearchTerms={Boolean(record.website || record.orderEmailSenders.length)}
  />
);

export const VendorAccountOrderMail: DetailSlotComponent<"vendorAccount"> = ({
  record,
}) => (
  <OrderMailWorklist
    vendorId={record.vendorId}
    ledgerPartyId={record.ledgerPartyId}
  />
);
