import {
  workQueueRecordInput,
  type WorkQueueRow,
} from "@cubby/schemas/work-queue";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { workQueue } from "~/integrations/tanstack-query/generated/catalog/workQueue.gen";
import { Ledger, LedgerCell, LedgerRow } from "~/ui/common/ledger";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { useHydrated } from "~/ui/hooks/use-hydrated";
import { Section } from "~/ui/layout";

import { WorkActions } from "./work-actions";
import { GapChip, OwnerPill } from "./work-queue-display";

const EMPTY_ROWS: WorkQueueRow[] = [];

/**
 * The record's own Work queue rows, one line each: failed checks (or the
 * reason), the row's declared actions, and who owns it. Absent rows render nothing;
 * a failed read shows its raw diagnostics.
 */
export function RecordWorkQueue({
  id,
  variant = "section",
}: {
  id: string;
  /** `rows` renders bare Needs-you rows for the detail page's block. */
  variant?: "section" | "rows";
}) {
  const hydrated = useHydrated();
  const input = workQueueRecordInput.safeParse({ id });
  const result = useQuery({
    ...workQueue.forRecord.queryOptions(input.data ?? { id }),
    enabled: hydrated && input.success,
  });
  if (result.isError)
    return variant === "rows" ? (
      <div data-needs-row className="px-3 py-2">
        <ErrorDisplay error={result.error} title="Work queue" />
      </div>
    ) : (
      <ErrorDisplay error={result.error} title="Work queue" />
    );
  // Loading holds Needs you open, like quality and suggestions.
  if (variant === "rows" && input.success && result.isPending)
    return <div data-needs-row aria-busy="true" className="min-h-10" />;
  const rows = result.data?.items ?? EMPTY_ROWS;
  if (rows.length === 0) return null;
  if (variant === "rows")
    return (
      <section
        aria-label="Work queue"
        className="divide-y divide-hairline-soft"
      >
        {rows.map((row) => (
          <div
            key={row.key}
            data-needs-row
            className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2"
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
      </section>
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
