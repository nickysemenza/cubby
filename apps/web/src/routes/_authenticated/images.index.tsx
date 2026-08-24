import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { Suspense } from "react";
import { listPage } from "~/app/_components/routing/entity-routes";
import ImageList from "~/app/images/imagelist";
import { SimpleLoading } from "~/components/feedback/loading-skeletons";
import { imageListSearchSchema } from "~/entities/list-search";
import { pageTitle } from "~/lib/page-title";

const ImagesBody = () => (
  <Suspense fallback={<SimpleLoading text="Loading images..." />}>
    <ImageList />
  </Suspense>
);

// Bound to a const, not inlined into the options object: the router plugin's
// splitter re-parses an inlined call expression with a JSX-less babel config,
// so only the identifier path survives a page body that renders JSX.
const ImagesPage = listPage({ title: "Images", list: ImagesBody });

export const Route = createFileRoute("/_authenticated/images/")({
  validateSearch: imageListSearchSchema,
  search: { middlewares: [stripSearchParams({})] },
  head: () => ({ meta: [{ title: pageTitle("Images") }] }),
  component: ImagesPage,
});
