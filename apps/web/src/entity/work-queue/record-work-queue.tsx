import {
  workQueueRecordInput,
  type WorkQueueRow,
} from "@cubby/schemas/work-queue";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { workQueue } from "~/integrations/tanstack-query/generated/domains/workQueue.gen";
import { formatCount } from "~/lib/number-format";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { useHydrated } from "~/ui/hooks/use-hydrated";
import { Panel, Section } from "~/ui/layout";
import { Ledger, LedgerCell, LedgerRow } from "~/ui/records/ledger";

import { WorkActions } from "./work-actions";
import { GapChip, OwnerPill } from "./work-queue-display";

const EMPTY_ROWS: WorkQueueRow[] = [];

/**
 * The record's own Work queue rows, one line each: failed checks (or the
 * reason), the row's declared actions, and who owns it. The detail page's
 * Needs-you block is these rows and their count; absent rows render nothing,
 * and a failed read shows its raw diagnostics.
 */
export function RecordWorkQueue({
  id,
  variant = "section",
}: {
  id: string;
  variant?: "section" | "needs-you";
}) {
  const hydrated = useHydrated();
  const input = workQueueRecordInput.safeParse({ id });
  const result = useQuery({
    ...workQueue.forRecord.queryOptions(input.data ?? { id }),
    enabled: hydrated && input.success,
  });
  const title = variant === "needs-you" ? "Needs you" : "Work queue";
  if (result.isError)
    return <ErrorDisplay error={result.error} title={title} />;
  const rows = result.data?.items ?? EMPTY_ROWS;
  if (rows.length === 0) return null;
  if (variant === "needs-you")
    return (
      <Section
        title={title}
        headingAs="h2"
        count={formatCount(rows.length)}
        data-testid="needs-you"
        actions={<Link to="/work-queue">Open queue</Link>}
      >
        <Panel tone="default" flush className="divide-y divide-hairline-soft">
          {rows.map((row) => (
            <div
              key={row.key}
              className="flex min-h-(--table-row-height) flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1"
            >
              <div className="flex min-w-0 flex-wrap items-center gap-1">
                {row.gaps.length > 0
                  ? row.gaps.map((gap) => <GapChip key={gap.check} gap={gap} />)
                  : row.reason}
              </div>
              <div className="min-w-0 flex-1">
                <WorkActions
                  actions={row.actions}
                  target={{ scope: "item", row }}
                />
              </div>
              <OwnerPill {...row} />
            </div>
          ))}
        </Panel>
      </Section>
    );
  return (
    <Section
      title="Work queue"
      headingAs="h3"
      compact
      actions={<Link to="/work-queue">Open queue</Link>}
    >
      <Ledger>
        {rows.map((row) => (
          <LedgerRow key={row.key}>
            <LedgerCell
              as="div"
              slot="primary"
              className="flex flex-wrap items-center gap-1"
            >
              {row.gaps.length > 0
                ? row.gaps.map((gap) => <GapChip key={gap.check} gap={gap} />)
                : row.reason}
            </LedgerCell>
            <LedgerCell as="div" slot="secondary">
              <WorkActions
                actions={row.actions}
                target={{ scope: "item", row }}
              />
            </LedgerCell>
            <LedgerCell as="div" slot="trailing">
              <OwnerPill {...row} />
            </LedgerCell>
          </LedgerRow>
        ))}
      </Ledger>
    </Section>
  );
}
