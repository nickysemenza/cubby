import { workQueueHouseholdInput } from "@cubby/schemas/work-queue";
import { createFileRoute } from "@tanstack/react-router";
import { useCallback } from "react";
import type { z } from "zod";

import { WorkQueuePage } from "~/features/work-queue/work-queue-page";
import { pageTitle } from "~/lib/page-title";
import { RouteErrorComponent } from "~/ui/route-error";
import { RoutePending } from "~/ui/route-pending";

export const Route = createFileRoute("/_authenticated/work-queue")({
  validateSearch: workQueueHouseholdInput,
  component: WorkQueueRoute,
  pendingComponent: RoutePending,
  errorComponent: RouteErrorComponent,
  head: () => ({ meta: [{ title: pageTitle("Work queue") }] }),
});

function WorkQueueRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const onChange = useCallback(
    (patch: Partial<z.infer<typeof workQueueHouseholdInput>>) => {
      void navigate({
        search: (previous) => ({ ...previous, ...patch }),
        replace: true,
      });
    },
    [navigate],
  );
  return <WorkQueuePage search={search} onChange={onChange} />;
}
