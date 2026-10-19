import type { MailImportStatus } from "@cubby/schemas/mail-import-settings";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { useActionMutation } from "~/entity/hooks/use-action-mutation";
import { AiFundingLine, PaidRunButton } from "~/features/account/ai-funding";
import {
  aiFunding,
  run,
} from "~/integrations/tanstack-query/generated/catalog.gen";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { Stack } from "~/ui/layout";
import { StatusText } from "~/ui/primitives/status-text";
import { Switch } from "~/ui/primitives/switch";

const MAIL_IMPORT_REFRESH_MS = 30_000;
/** Poll only while a switched-on mailbox still has searches to run. */
export const mailImportRefetchInterval = (
  status: MailImportStatus | undefined,
): number | false =>
  status?.mailboxes.some(
    ({ enabled, searches }) =>
      enabled &&
      (searches.inProgress !== null || searches.nextPending.length > 0),
  )
    ? MAIL_IMPORT_REFRESH_MS
    : false;

/** Targeted-search progress over today's targets, then the search queue. */
function MailSearchSummary({
  searches,
}: {
  searches: MailImportStatus["mailboxes"][number]["searches"];
}) {
  const { vendors, charges, inProgress, nextPending } = searches;
  return (
    <div className="space-y-1 text-xs text-muted-foreground">
      <p className="tabular-nums">
        Searches: Vendors {vendors.completed}/{vendors.total} · charges{" "}
        {charges.completed}/{charges.total}
      </p>
      {inProgress ? (
        <p className="truncate">
          Searching <span className="text-foreground">{inProgress.query}</span>
        </p>
      ) : null}
      {nextPending.length > 0 ? (
        <div>
          <p>Up next</p>
          <ul className="ms-3 list-disc">
            {nextPending.map((query) => (
              <li key={query.key} className="truncate">
                {query.query}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/** Discovery waits for free capacity unless the member allows paid work. */
export function MailImportSettings() {
  const queryClient = useQueryClient();
  const status = useQuery({
    ...run.mailImport.queryOptions({}),
    // Vendor writes don't invalidate this query, so a cached "all done" result
    // would otherwise keep polling off after targets change.
    refetchOnMount: true,
    refetchInterval: (query) => mailImportRefetchInterval(query.state.data),
  });
  const toggle = useActionMutation({
    mutationFn: () => run.setMailImport.mutationOptions(),
    success: "Mail import updated",
    error: "Couldn't update Mail import",
    onSuccess: (data) => {
      queryClient.setQueryData(run.mailImport.queryOptions({}).queryKey, data);
    },
  });
  const funding = useQuery(aiFunding.status.queryOptions({}));
  const discover = useActionMutation({
    mutationFn: () => run.discoverMail.mutationOptions(),
    success: (data) =>
      data.started > 0
        ? "Discovery started with paid models allowed"
        : "Discovery is already running; paid models are now allowed for it",
    error: "Couldn't start discovery",
  });
  const mailboxes = status.data?.mailboxes ?? [];
  const budget = funding.data;
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        When on, daily discovery reads new mail and searches the history of
        known Vendors and unmatched transactions. Unambiguous purchases are
        imported; anything uncertain waits in the{" "}
        <Link to="/work-queue" className="underline">
          Work queue
        </Link>
        . Inventory is never received automatically.
      </p>

      <Stack gap="md">
        {status.isLoading ? (
          <StatusText>Loading connected mailboxes…</StatusText>
        ) : null}
        {status.error ? <ErrorDisplay error={status.error} /> : null}
        {status.data && mailboxes.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Connect Google &amp; Gmail above to turn on Mail import.
          </p>
        ) : null}
        {mailboxes.map((mailbox) => {
          const id = `mail-import-${mailbox.mailboxId}`;
          return (
            <div key={mailbox.mailboxId}>
              <label
                htmlFor={id}
                className="flex min-h-11 items-center justify-between gap-4 text-sm"
              >
                <span className="min-w-0 truncate">{mailbox.mailboxId}</span>
                <Switch
                  id={id}
                  checked={mailbox.enabled}
                  disabled={toggle.isPending}
                  onCheckedChange={(enabled) =>
                    toggle.mutate({ mailboxId: mailbox.mailboxId, enabled })
                  }
                />
              </label>
              <MailSearchSummary searches={mailbox.searches} />
              {mailbox.enabled ? (
                <div className="mt-2">
                  <PaidRunButton
                    label="Run discovery now, paid allowed"
                    budget={budget}
                    pending={discover.isPending}
                    onConfirm={(paidOverBudgetUsd) =>
                      discover.mutate({
                        mailboxId: mailbox.mailboxId,
                        paidAllowed: true,
                        paidOverBudgetUsd,
                      })
                    }
                  />
                </div>
              ) : null}
            </div>
          );
        })}
        {mailboxes.length > 0 ? (
          <Link
            to="/runs"
            search={{ purpose: "mail_import", status: "needs_review" }}
            className="text-sm underline"
          >
            Mail imports waiting for review
          </Link>
        ) : null}
        {budget ? <AiFundingLine budget={budget} /> : null}
      </Stack>
    </div>
  );
}
