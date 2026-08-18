import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { Suspense } from "react";
import { z } from "zod";
import { tableSearchFields } from "~/app/_components/data-table/table-search";
import ImageList from "~/app/images/imagelist";
import { SimpleLoading } from "~/components/feedback/loading-skeletons";
import { Page } from "~/components/page/Page";
import { entityFilterSearchFields } from "~/entities/filter-search-fields";
import { pageTitle } from "~/lib/page-title";
import { urlEnumListParam } from "~/lib/search-params";

export const imageListSearchSchema = z.object({
  ...tableSearchFields,
  ...entityFilterSearchFields("image"),
  status: urlEnumListParam(ImageStatus),
});

export const Route = createFileRoute("/_authenticated/images/")({
  validateSearch: imageListSearchSchema,
  search: { middlewares: [stripSearchParams({})] },
  head: () => ({ meta: [{ title: pageTitle("Images") }] }),
  component: ImagesPage,
});

function ImagesPage() {
  return (
    <Page variant="list" headerInToolbar title="Images" fullWidth>
      <Suspense fallback={<SimpleLoading text="Loading images..." />}>
        <ImageList />
      </Suspense>
    </Page>
  );
}

import { ImageStatus } from "@cubby/schemas/image";
