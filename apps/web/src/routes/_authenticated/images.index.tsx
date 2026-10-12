import { createFileRoute, stripSearchParams } from "@tanstack/react-router";

import { UploadImageDialog } from "~/app/images/upload-image-dialog";
import { entitySearch } from "~/entity/generated/entity-search.gen";
import { imageListOverride } from "~/entity/list-columns/image";
import { listPage } from "~/entity/routing/list-page";
import { pageTitle } from "~/lib/page-title";

// Hand-written (`route.list: null`) only for the upload dialog, this route's
// create trigger; the generic list reads the kernel image list.
const ImagesPage = listPage({
  entity: "image",
  override: imageListOverride,
  actions: () => <UploadImageDialog />,
});

export const Route = createFileRoute("/_authenticated/images/")({
  validateSearch: entitySearch.image.schema,
  search: { middlewares: [stripSearchParams(entitySearch.image.defaults)] },
  head: () => ({ meta: [{ title: pageTitle("Images") }] }),
  component: ImagesPage,
});
