import { createFileRoute, stripSearchParams } from "@tanstack/react-router";

import { listPage } from "~/app/_components/routing/entity-routes";
import { ImageList } from "~/app/images/imagelist";
import { entitySearch } from "~/entities/generated/entity-search.gen";
import { pageTitle } from "~/lib/page-title";

// Hand-written: the image list is not a kernel list (no create contract), so
// `route.list` is null and this module owns the page over `ImageList`.
const ImagesPage = listPage({
  title: "Images",
  entity: "image",
  list: ImageList,
});

export const Route = createFileRoute("/_authenticated/images/")({
  validateSearch: entitySearch.image.schema,
  search: { middlewares: [stripSearchParams(entitySearch.image.defaults)] },
  head: () => ({ meta: [{ title: pageTitle("Images") }] }),
  component: ImagesPage,
});
