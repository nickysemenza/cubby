import {
  ledgerPartyShortcode,
  vendorShortcode,
} from "@cubby/schemas/identifiers";
import type {
  VendorOrderMailOut,
  VendorSearchMailOut,
} from "@cubby/schemas/order-mail-review";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import type { DetailSlotComponent } from "~/app/_components/entity-detail/detail-slots";
import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
import { Row, Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { NativeSelect } from "~/components/ui/native-select";
import { StatusText } from "~/components/ui/status-text";
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
  const search = useActionMutation({
    mutationFn: vendor.searchOrderMail.mutationOptions,
    error: "Gmail search failed",
    onSuccess: (result) => {
      setSearchPage(result);
      void worklist.refetch();
    },
  });
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
              disabled={search.isPending || !hasSearchTerms}
              onClick={() => {
                const vendorCode = vendorShortcode.parse(vendorId);
                if (searchPage?.nextPageToken) {
                  search.mutate({
                    vendorId: vendorCode,
                    after: searchPage.after,
                    pageToken: searchPage.nextPageToken,
                  });
                } else {
                  search.mutate({ vendorId: vendorCode });
                }
              }}
            >
              {search.isPending
                ? "Searching Gmail…"
                : searchPage?.nextPageToken
                  ? "Search older email"
                  : "Search Gmail now"}
            </Button>
            <span className="text-xs text-muted-foreground">
              {hasSearchTerms
                ? "Saved matches appear below. Search the past year using this Vendor’s website and known senders."
                : "Add a website to this Vendor to search Gmail."}
            </span>
          </Row>
          {searchPage ? (
            <StatusText>
              Searched {searchPage.searched} messages; {searchPage.reviewable}{" "}
              order email{searchPage.reviewable === 1 ? "" : "s"} in this
              worklist.
            </StatusText>
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
        <StatusText>No order email has been matched to this Vendor.</StatusText>
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
