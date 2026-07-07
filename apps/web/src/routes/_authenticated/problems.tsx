import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
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

  // The validate card is a sibling of <ProblemsOverview />, NOT nested inside
  // it: ProblemsOverview has an isLoading early-return over five detector query
  // groups, and this phone-at-the-shelf workflow must render immediately without
  // waiting for detectors.
  const validateCard = (
    <Section
      title="Validate locations"
      description="Scan a location's QR-labeled children to confirm they're all in place, and reassign any that have moved."
    >
      <LocationValidateForm initialParentId={validateParent} />
    </Section>
  );

  return (
    <Page variant="list" title="Data Problems">
      {validateParent ? (
        // Deep-linked from a location: lead with the validate flow.
        <Stack gap="lg">
          {validateCard}
          <ProblemsOverview />
        </Stack>
      ) : (
        <Stack gap="lg">
          <ProblemsOverview />
          {validateCard}
        </Stack>
      )}
    </Page>
  );
}
