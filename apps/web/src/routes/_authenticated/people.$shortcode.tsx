import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { PersonDetail } from "~/app/people/person-detail";
import { useDetailTitle } from "~/hooks/useDocumentTitle";
import { useTRPC } from "~/integrations/trpc/react";
import { shortcodeHead } from "~/lib/page-title";
export const Route = createFileRoute("/_authenticated/people/$shortcode")({
  loader: async ({ params, context }) => {
    const item = await context.queryClient.ensureQueryData(
      context.trpc.person.getByShortcode.queryOptions({
        shortcode: params.shortcode,
      }),
    );
    if (!item) throw notFound();
  },
  head: shortcodeHead,
  component: PersonPage,
});
function PersonPage() {
  const api = useTRPC();
  const { shortcode } = Route.useParams();
  const { data } = useSuspenseQuery(
    api.person.getByShortcode.queryOptions({ shortcode }),
  );
  useDetailTitle(shortcode, data?.name);
  return data ? <PersonDetail person={data} /> : null;
}
