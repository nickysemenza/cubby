import { createFileRoute } from "@tanstack/react-router";

import { ensureDetailRecord } from "~/app/_components/routing/detail-loader";
import {
  detailPage,
  notFoundPage,
} from "~/app/_components/routing/entity-routes";
import ImageDetailPageContent from "~/app/images/image-detail-page";
import { RouteErrorComponent } from "~/components/lazy-route-error";
import { DetailPagePending } from "~/components/route-pending";
import { image } from "~/entities/image.functions";
import { shortcodeHead } from "~/lib/page-title";

const ImageDetailPage = detailPage({
  query: (shortcode) => image.detail.queryOptions({ id: shortcode }),
  render: (imageDetails, shortcode) => (
    <ImageDetailPageContent key={shortcode} imageDetails={imageDetails} />
  ),
  title: (imageDetails) => imageDetails.filename,
});

const ImageNotFound = notFoundPage(
  "image",
  "Image not found",
  "This image is no longer available.",
);

export const Route = createFileRoute("/_authenticated/images/$shortcode")({
  loader: ({ params, context }) =>
    ensureDetailRecord(
      context.queryClient,
      image.detail.queryOptions({ id: params.shortcode }),
    ),
  pendingComponent: DetailPagePending,
  errorComponent: RouteErrorComponent,
  notFoundComponent: ImageNotFound,
  head: shortcodeHead,
  component: ImageDetailPage,
});
