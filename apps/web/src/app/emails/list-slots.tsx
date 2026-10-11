import type { ListSlotId } from "@cubby/schemas/entity-manifest";
import { useQuery } from "@tanstack/react-query";

import { ReportBlocks } from "~/entity/entity-detail/report-slot";
import type { ListSlotComponent } from "~/entity/entity-list/list-slot-types";
import { purchaseImport } from "~/integrations/tanstack-query/generated/catalog.gen";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { Skeleton } from "~/ui/primitives/skeleton";

const EmailAccuracySlot: ListSlotComponent = () => {
  const query = useQuery(purchaseImport.emailAccuracyView.queryOptions({}));
  if (query.isPending) return <Skeleton className="h-32 w-full" />;
  if (query.isError)
    return (
      <ErrorDisplay
        error={query.error}
        title="Email accuracy"
        onRetry={() => void query.refetch()}
      />
    );
  return <ReportBlocks blocks={query.data.blocks} />;
};

export const emailListSlots = {
  accuracy: EmailAccuracySlot,
} satisfies Record<ListSlotId<"email">, ListSlotComponent>;
