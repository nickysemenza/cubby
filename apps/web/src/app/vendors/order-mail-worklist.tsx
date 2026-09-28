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

import type { DetailSlotComponent } from "~/app/_components/entity-detail/detail-slots";
import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
import { Row, Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { NativeSelect } from "~/components/ui/native-select";
import { StatusText } from "~/components/ui/status-text";
import { TechnicalError } from "~/components/ui/technical-error";
import { formatCurrency } from "~/lib/utils";

import { vendor } from "./vendor.functions";

type MailEvent = VendorOrderMailOut["items"][number]["events"][number];

function OrderMailEvent({ event }: { event: MailEvent }) {
  const decide = useActionMutation({
    mutationFn: vendor.decideOrderMail.mutationOptions,
    success: "Order email match reviewed",
  });
  return (
    <div className="border-t border-border pt-2 text-sm">
      <Row align="center" justify="between" gap="sm" className="flex-wrap">
        <span className="font-medium">
          {event.event === "other" ? "Other update" : event.event} ·{" "}
          {event.orderId ?? "Order unknown"}
        </span>
        {event.amount !== null ? (
          <span className="font-mono tabular-nums">
            {formatCurrency(event.amount)}
          </span>
        ) : null}
      </Row>
      {event.candidates.length === 0 ? (
        <p className="mt-1 text-muted-foreground">No likely Purchase yet.</p>
      ) : (
        <div className="mt-2 grid gap-2">
          {event.candidates.map((candidate) => (
            <Row
              key={candidate.purchaseId}
              align="center"
              justify="between"
              gap="sm"
              className="flex-wrap rounded-md bg-muted/50 px-2 py-1"
            >
              <div className="flex min-w-0 items-center gap-2">
                <a
                  className="font-medium text-primary hover:underline"
                  href={`/purchases/${candidate.purchaseId}`}
                >
                  {candidate.orderId ?? candidate.purchaseId}
                </a>
                <span className="text-xs text-muted-foreground">
                  {candidate.reason.replaceAll("_", " ")}
                </span>
                {candidate.decision ? (
                  <Badge variant="secondary">{candidate.decision}</Badge>
                ) : null}
              </div>
              <div className="flex gap-2">
                {candidate.decision !== "linked" ? (
                  <Button
                    size="sm"
                    variant="outline"
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
                    size="sm"
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
          ))}
        </div>
      )}
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
  const [searchPage, setSearchPage] = useState<VendorSearchMailOut | null>(
    null,
  );
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
      query.state.data?.status === "running"
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
    currentJob?.status === "queued" || currentJob?.status === "running";
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
              {currentJob.status === "queued" ? (
                currentJob.error ? (
                  <div>
                    <span>Rate limited. This page will retry shortly.</span>
                    <TechnicalError error={currentJob.error} tone="muted" />
                  </div>
                ) : (
                  "Waiting for the background worker. View the Run for wait time and retry."
                )
              ) : null}
              {currentJob.status === "running"
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
      {worklist.data.items.length === 0 ? (
        <StatusText>
          {jobActive
            ? "Searching for order email. Matches will appear when the job finishes."
            : "No order email has been matched to this Vendor."}
        </StatusText>
      ) : (
        worklist.data.items.map((mail) => (
          <article
            key={mail.messageId}
            className="rounded-lg border border-border bg-card p-3"
          >
            <Row align="start" justify="between" gap="sm" className="flex-wrap">
              <div>
                <div className="font-medium">{mail.subject}</div>
                <div className="text-xs text-muted-foreground">
                  {mail.sender} · {new Date(mail.receivedAt).toLocaleString()}
                </div>
              </div>
              {mail.threadId ? (
                <a
                  className="text-xs font-medium text-primary hover:underline"
                  href={`https://mail.google.com/mail/u/0/#all/${encodeURIComponent(mail.threadId)}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open Gmail conversation
                </a>
              ) : null}
            </Row>
            <div className="mt-2 grid gap-2">
              {mail.events.map((event) => (
                <OrderMailEvent key={event.id} event={event} />
              ))}
            </div>
            <details className="mt-2 text-xs text-muted-foreground">
              <summary>Technical details</summary>
              <div>Message ID: {mail.messageId}</div>
              {mail.threadId ? <div>Thread ID: {mail.threadId}</div> : null}
            </details>
          </article>
        ))
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
