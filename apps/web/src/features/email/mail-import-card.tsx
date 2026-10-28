import type { MailImportStatus } from "@cubby/schemas/mail-import-settings";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { useActionMutation } from "~/entity/hooks/use-action-mutation";
import { run } from "~/integrations/tanstack-query/generated/domains/run.gen";
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

/** Discovery spends within the household AI funding budgets. */
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
  const mailboxes = status.data?.mailboxes ?? [];
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        When on, daily discovery reads new mail and searches the history of
        known Vendors, observed shared senders and unmatched transactions.
        Unambiguous purchases are imported; anything uncertain waits in the{" "}
        <Link to="/work-queue" className="underline">
          Work queue
        </Link>
        . Turning this off prevents new automatic imports; previously admitted
        work may finish. Inventory is never received automatically.
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
                <span className="min-w-0 truncate">{mailbox.label}</span>
                <Switch
                  id={id}
                  checked={mailbox.enabled}
                  disabled={toggle.isPending}
                  onCheckedChange={(enabled) =>
                    toggle.mutate({ mailboxId: mailbox.mailboxId, enabled })
                  }
                />
              </label>
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
        <Link
          to="/emails/coverage"
          search={{}}
          className="self-start text-sm underline"
        >
          View Mail coverage and import a Vendor
        </Link>
      </Stack>
    </div>
  );
}
