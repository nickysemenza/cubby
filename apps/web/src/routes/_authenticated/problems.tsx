import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";
import { LocationValidateForm } from "~/app/problems/components/location-validate-card";
import { ProblemsOverview } from "~/app/problems/problems-overview";
import { Section, Stack } from "~/components/layout";
import { Page } from "~/components/page/Page";
import { RoutePending } from "~/components/route-pending";

const searchSchema = z.object({
  // Deep-link target for the phone-at-the-shelf location-validate flow (folded
  // in from the retired /locations/validate route). When set, the validate card
  // renders prominently at the top of the page.
  validateParent: z.string().optional().catch(undefined),
});

const searchDefaults = { validateParent: undefined } as const;

export const Route = createFileRoute("/_authenticated/problems")({
  validateSearch: searchSchema,
  search: { middlewares: [stripSearchParams(searchDefaults)] },
  // Best-effort warm of the cheap DB-only group only — NON-blocking (void), like
  // every other loader here: the SSR trpc client targets localhost (unreachable
  // on CF Workers, unauthenticated in dev), so awaiting would throw into the
  // error boundary. useProblemsData fetches all hot groups client-side (each its
  // own Worker invocation/CPU budget) and the page's skeleton covers cold loads.
  // The heavy WASM/network groups are deliberately NOT prefetched here — keeping
  // their CPU out of the SSR invocation is the whole point.
  loader: ({ context }) => {
    void context.queryClient.prefetchQuery(
      context.trpc.problems.getFast.queryOptions(),
    );
  },
  pendingComponent: RoutePending,
  component: ProblemsPage,
  head: () => ({ meta: [{ title: "Problems | cubby" }] }),
});

function ProblemsPage() {
  const { validateParent } = Route.useSearch();

  // Lead with the validate flow only when the page was ENTERED via a deep link.
  // Captured once in a state initializer: if the param later changes (e.g.
  // stripSearchParams removing it after the flow finishes), the section order
  // must not swap — a positional swap would remount both children, discarding
  // in-progress scan state and refiring all five detector groups.
  const [leadWithValidate] = useState(() => validateParent != null);

  // The validate card is a sibling of <ProblemsOverview />, NOT nested inside
  // it: ProblemsOverview has an isLoading early-return over five detector query
  // groups, and this phone-at-the-shelf workflow must render immediately without
  // waiting for detectors. Keyed by parent so a NEW deep link (A → B) remounts
  // the form fresh instead of keeping stale scan state for the old parent.
  const validateCard = (
    <Section
      title="Validate locations"
      description="Scan a location's QR-labeled children to confirm they're all in place, and reassign any that have moved."
    >
      <LocationValidateForm
        key={validateParent ?? "manual"}
        initialParentId={validateParent}
      />
    </Section>
  );

  return (
    <Page variant="list" title="Data Problems">
      <Stack gap="lg">
        {leadWithValidate ? validateCard : <ProblemsOverview />}
        {leadWithValidate ? <ProblemsOverview /> : validateCard}
      </Stack>
    </Page>
  );
}
