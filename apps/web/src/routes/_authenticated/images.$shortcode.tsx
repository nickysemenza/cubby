import { createFileRoute } from "@tanstack/react-router";
import ImageDetailPageContent from "~/app/images/image-detail-page";
import { RouteErrorComponent } from "~/components/lazy-route-error";
import { pageTitle } from "~/lib/page-title";

export const Route = createFileRoute("/_authenticated/images/$shortcode")({
  // The title is purely param-derived, so `head` covers it — no imperative
  // document.title write needed here.
  head: ({ params }) => ({
    meta: [{ title: pageTitle(`Image ${params.shortcode}`) }],
  }),
  component: ImageDetailPage,
  errorComponent: RouteErrorComponent,
});

function ImageDetailPage() {
  const { shortcode } = Route.useParams();
  return <ImageDetailPageContent shortcode={shortcode} />;
}
