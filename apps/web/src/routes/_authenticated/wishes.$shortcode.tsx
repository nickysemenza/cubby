import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { WishDetail } from "~/app/wishes/wish-detail";
import { RouteErrorComponent } from "~/components/lazy-route-error";
import { Page } from "~/components/page/Page";
import { DetailPagePending } from "~/components/route-pending";
import { Empty, EmptyDescription, EmptyTitle } from "~/components/ui/empty";
import { useDetailTitle } from "~/hooks/useDocumentTitle";
import { useTRPC } from "~/integrations/trpc/react";
import { shortcodeHead } from "~/lib/page-title";

export const Route = createFileRoute("/_authenticated/wishes/$shortcode")({
  ssr: false,
  loader: async ({ params, context }) => {
    const wish = await context.queryClient.ensureQueryData(
      context.trpc.wish.getByShortcode.queryOptions({
        shortcode: params.shortcode,
      }),
    );
    if (!wish) throw notFound();
  },
  pendingComponent: DetailPagePending,
  errorComponent: RouteErrorComponent,
  notFoundComponent: () => (
    <Page variant="list" entity="wish" title="Wishlist item not found" compact>
      <Empty>
        <EmptyTitle>Wishlist item not found</EmptyTitle>
        <EmptyDescription>It may have been deleted.</EmptyDescription>
      </Empty>
    </Page>
  ),
  head: shortcodeHead,
  component: WishDetailPage,
});

function WishDetailPage() {
  const { shortcode } = Route.useParams();
  const api = useTRPC();
  const { data: wish } = useSuspenseQuery(
    api.wish.getByShortcode.queryOptions({ shortcode }),
  );
  useDetailTitle(shortcode, wish?.name);
  return wish ? <WishDetail key={shortcode} wish={wish} /> : null;
}
