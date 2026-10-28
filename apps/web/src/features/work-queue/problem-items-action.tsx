import type { ProblemItem, ProblemKey } from "@cubby/schemas/problems";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";

import {
  WorkActionDialogTrigger,
  type WorkActionProps,
} from "~/entity/work-queue/work-actions";
import { problems } from "~/integrations/tanstack-query/generated/domains/problems.gen";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { Stack } from "~/ui/layout";
import { Overlay } from "~/ui/overlays/overlay";

/**
 * A Problem's guided flow over its detector items. A diagnostic's queue row
 * counts items it does not carry (a duplicate pair, a claim's claimants), so
 * the flow reads the detector's current items and renders each with its
 * domain's fix; `matches` narrows them to the row's own record.
 */
export function ProblemItemsAction<K extends ProblemKey>({
  action,
  target,
  problemKey,
  matches,
  children,
}: WorkActionProps<"item"> & {
  problemKey: K;
  matches?: (item: ProblemItem<K>, recordId: string) => boolean;
  children: (item: ProblemItem<K>, close: () => void) => ReactNode;
}) {
  return (
    <WorkActionDialogTrigger action={action}>
      {(close) => (
        <Overlay
          open
          onOpenChange={(open) => !open && close()}
          title={action.label}
          size="lg"
          cancelLabel="Done"
        >
          <ProblemItems
            problemKey={problemKey}
            recordId={target.row.id}
            matches={matches}
            close={close}
          >
            {children}
          </ProblemItems>
        </Overlay>
      )}
    </WorkActionDialogTrigger>
  );
}

function ProblemItems<K extends ProblemKey>({
  problemKey,
  recordId,
  matches,
  close,
  children,
}: {
  problemKey: K;
  recordId: string | null;
  matches?: (item: ProblemItem<K>, recordId: string) => boolean;
  close: () => void;
  children: (item: ProblemItem<K>, close: () => void) => ReactNode;
}) {
  const report = useQuery(
    problems.report.queryOptions({
      type: problemKey,
      countsOnly: false,
      pageSize: 100,
    }),
  );
  if (report.isError)
    return <ErrorDisplay error={report.error} title={problemKey} />;
  if (!report.data) return <p className="text-sm">Loading…</p>;
  // SAFETY: a typed report returns that detector's public items.
  const items = (
    "items" in report.data ? report.data.items : []
  ) as ProblemItem<K>[];
  const shown =
    recordId && matches
      ? items.filter((item) => matches(item, recordId))
      : items;
  if (shown.length === 0)
    return (
      <p className="text-sm text-muted-foreground">Nothing left to fix.</p>
    );
  return (
    <Stack gap="lg">
      {shown.map((item) => (
        // Detector items share no id field; their content identifies them.
        <div key={JSON.stringify(item)}>{children(item, close)}</div>
      ))}
    </Stack>
  );
}
