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

import { DetailAction } from "~/entity/entity-detail/detail-action-bar";
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

type MailEvent = VendorOrderMailOut["items"][number]["events"][number];
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
      } as const;
    case "amount_and_date":
      return {
        label: "Possible match",
        explanation: "Amount and date match",
        tone: "secondary",
      } as const;
    case "nearby_date":
      return {
        label: "Weak lead",
        explanation: "Date only",
        tone: "outline",
      } as const;
    case "previous_decision":
      return {
        label: "Reviewed",
        explanation: "Previous decision",
        tone: "secondary",
      } as const;
  }
};

function OrderMailEvent({
  event,
  ledgerPartyId,
  selection,
  onSelect,
}: {
  event: MailEvent;
  ledgerPartyId: string;
  selection: MailSelection;
  onSelect: (checked: boolean) => void;
}) {
  const importOrder = useActionMutation({
    mutationFn: vendor.importOrderMail.mutationOptions,
    success: "Order import started",
  });
  const canImport =
    event.event === "placed" &&
    event.orderId &&
    !event.candidates.some(
      (candidate) =>
        candidate.reason === "exact_order_id" ||
        candidate.decision === "linked",
    );
  const decide = useActionMutation({
    mutationFn: vendor.decideOrderMail.mutationOptions,
    success: "Order email match reviewed",
  });
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
      <span className="font-medium">
        {event.event === "other" ? "Other update" : event.event} ·{" "}
        <span className="font-mono">{event.orderId ?? "Order unknown"}</span>
      </span>
      {canImport && !importOrder.data ? (
        <div className="flex items-center gap-1.5">
          <Checkbox
            aria-label={`Select order ${event.orderId} to import with others`}
            checked={selection.has(event.id)}
            // One run covers one member's mail.
            disabled={[...selection.values()].some(
              (picked) => picked.ledgerPartyId !== ledgerPartyId,
            )}
            onCheckedChange={(checked) => onSelect(checked === true)}
          />
          <Button
            size="xs"
            variant="outline"
            disabled={importOrder.isPending}
            title="The agent reads the saved confirmation and imports its itemized order."
            onClick={() =>
              importOrder.mutate({
                eventId: event.id,
                evidenceChecksum: event.evidenceChecksum,
              })
            }
          >
            {importOrder.isPending ? "Starting import…" : "Import order"}
          </Button>
        </div>
      ) : null}
      {canImport && importOrder.data ? (
        <Link
          to="/runs/$shortcode"
          params={{ shortcode: importOrder.data.runId }}
          className="text-xs text-primary underline underline-offset-4"
        >
          View import
        </Link>
      ) : null}
      {event.candidates.length === 0 ? (
        <span className="text-xs text-muted-foreground">
          No likely Purchase yet.
        </span>
      ) : (
        event.candidates.map((candidate) => {
          const evidence = matchEvidence(candidate);
          return (
            <Row
              key={candidate.purchaseId}
              align="center"
              gap="xs"
              className="rounded-md bg-muted/50 py-0.5 ps-2 pe-0.5"
            >
              <div className="flex min-w-0 items-center gap-1.5">
                <Link
                  className="font-medium text-primary hover:underline"
                  to="/purchases/$shortcode"
                  params={{ shortcode: candidate.purchaseId }}
                >
                  {candidate.orderId ?? candidate.purchaseId}
                </Link>
                <Badge variant={evidence.tone}>{evidence.label}</Badge>
                <span className="text-xs text-muted-foreground">
                  {evidence.explanation}
                </span>
                {candidate.decision ? (
                  <Badge variant="secondary">{candidate.decision}</Badge>
                ) : null}
              </div>
              <div className="flex">
                {candidate.decision !== "linked" ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={decide.isPending}
                    onClick={() =>
                      decide.mutate({
                        eventId: event.id,
                        purchaseId: candidate.purchaseId,
                        decision: "linked",
                        evidenceChecksum: event.evidenceChecksum,
                      })
                    }
                  >
                    Link
                  </Button>
                ) : null}
                {candidate.decision !== "dismissed" ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={decide.isPending}
                    onClick={() =>
                      decide.mutate({
                        eventId: event.id,
                        purchaseId: candidate.purchaseId,
                        decision: "dismissed",
                        evidenceChecksum: event.evidenceChecksum,
                      })
                    }
                  >
                    Dismiss
                  </Button>
                ) : null}
              </div>
            </Row>
          );
        })
      )}
      {event.amount !== null ? (
        <span className="ml-auto font-mono tabular-nums">
          {formatCurrency(event.amount)}
        </span>
      ) : null}
      {importOrder.error ? (
        <div className="basis-full">
          <TechnicalError error={getErrorMessage(importOrder.error)} />
        </div>
      ) : null}
    </div>
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
  const jobStatus = useVendorMailJob(vendorId, canSearch);
  const currentJob = jobStatus.data;
  const { jobActive, resumablePage } = mailSearchState(currentJob);
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
            <DetailAction>
              <VendorMailSearchActions
                vendorId={vendorId}
                hasSearchTerms={hasSearchTerms}
              />
            </DetailAction>
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
          {worklist.data.items.map((mail) => (
            <article key={mail.messageId} className="px-3 py-2">
              <div className="flex min-w-0 items-baseline gap-2 text-xs text-muted-foreground">
                {mail.threadId ? (
                  <a
                    className="min-w-0 truncate text-sm font-medium text-foreground hover:underline"
                    href={gmailThreadUrl(mail.threadId)}
                    target="_blank"
                    rel="noreferrer"
                    title="Open Gmail conversation"
                  >
                    {mail.subject}
                  </a>
                ) : (
                  <span className="min-w-0 truncate text-sm font-medium text-foreground">
                    {mail.subject}
                  </span>
                )}
                <span className="min-w-0 shrink-[2] truncate">
                  {mail.sender}
                </span>
                <span
                  className="ml-auto shrink-0 font-mono tabular-nums"
                  title={formatInstant(mail.receivedAt, "dateTime")}
                >
                  {formatInstant(mail.receivedAt, "dateShort")}
                </span>
                <details className="shrink-0">
                  <summary className="cursor-pointer">IDs</summary>
                  <div className="font-mono">Message ID: {mail.messageId}</div>
                  {mail.threadId ? (
                    <div className="font-mono">Thread ID: {mail.threadId}</div>
                  ) : null}
                </details>
              </div>
              <div className="mt-1 grid gap-1">
                {mail.events.map((event) => (
                  <OrderMailEvent
                    key={event.id}
                    event={event}
                    ledgerPartyId={mail.ledgerPartyId}
                    selection={selection}
                    onSelect={(checked) =>
                      setSelection((current) => {
                        const next = new Map(current);
                        if (checked)
                          next.set(event.id, {
                            evidenceChecksum: event.evidenceChecksum,
                            ledgerPartyId: mail.ledgerPartyId,
                          });
                        else next.delete(event.id);
                        return next;
                      })
                    }
                  />
                ))}
              </div>
            </article>
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

function useVendorMailJob(vendorId: string, enabled = true) {
  return useQuery({
    ...vendor.orderMailSearchStatus.queryOptions({
      vendorId: vendorShortcode.parse(vendorId),
    }),
    enabled: enabled,
    refetchInterval: (query) =>
      query.state.data?.status === "queued" ||
      query.state.data?.status === "running" ||
      query.state.data?.status === "waiting"
        ? 2_000
        : false,
  });
}
export const VendorMailActions: DetailSlotComponent<"vendor"> = ({
  record,
}) => (
  <VendorMailSearchActions
    vendorId={record.id}
    hasSearchTerms={Boolean(record.website || record.orderEmailSenders.length)}
  />
);
function VendorMailSearchActions({
  vendorId,
  hasSearchTerms,
}: {
  vendorId: string;
  hasSearchTerms: boolean;
}) {
  const jobStatus = useVendorMailJob(vendorId);
  const search = useActionMutation({
    mutationFn: vendor.searchOrderMail.mutationOptions,
    error: "Gmail search failed",
    onSuccess: () => {
      void jobStatus.refetch();
    },
  });
  const currentJob = jobStatus.data;
  const { jobActive, resumablePage, completedPage } =
    mailSearchState(currentJob);
  return (
    <>
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
    </>
  );
}

function mailSearchState(currentJob: VendorSearchMailOut | null | undefined) {
  const jobActive =
    currentJob?.status === "queued" ||
    currentJob?.status === "running" ||
    currentJob?.status === "waiting";
  const completedPage = currentJob?.status === "completed" ? currentJob : null;
  const resumablePage =
    currentJob?.status === "failed" && currentJob.nextPageToken
      ? currentJob
      : null;
  return { jobActive, resumablePage, completedPage };
}
