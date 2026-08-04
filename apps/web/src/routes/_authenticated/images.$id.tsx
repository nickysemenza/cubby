import { createFileRoute } from "@tanstack/react-router";
import ImageDetailPageContent from "~/app/images/image-detail-page";
import { RouteErrorComponent } from "~/components/lazy-route-error";
import { useDocumentTitle } from "~/hooks/useDocumentTitle";

export const Route = createFileRoute("/_authenticated/images/$id")({
  component: ImageDetailPage,
  errorComponent: RouteErrorComponent,
});

function ImageDetailPage() {
  const { id } = Route.useParams();
  useDocumentTitle(`Image ${id}`);
  return <ImageDetailPageContent id={id} />;
}
