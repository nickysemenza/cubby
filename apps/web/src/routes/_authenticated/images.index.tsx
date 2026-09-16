import { createFileRoute, stripSearchParams } from "@tanstack/react-router";

import { listPage } from "~/app/_components/routing/entity-routes";
import { UploadImageDialog } from "~/app/images/upload-image-dialog";
import { entitySearch } from "~/entities/generated/entity-search.gen";
import { pageTitle } from "~/lib/page-title";

// Hand-written: the image list is not a kernel list (no create contract), so
// `route.list` is null; the generic list reads it through the image override
// module's own source, and the upload dialog is this route's create trigger.
const ImagesPage = listPage({
  entity: "image",
  actions: () => <UploadImageDialog />,
});

export const Route = createFileRoute("/_authenticated/images/")({
  validateSearch: entitySearch.image.schema,
  search: { middlewares: [stripSearchParams(entitySearch.image.defaults)] },
  head: () => ({ meta: [{ title: pageTitle("Images") }] }),
  component: ImagesPage,
});
