import { createFileRoute } from "@tanstack/react-router";
import { Suspense } from "react";
import ImageList from "~/app/images/imagelist";
import { SimpleLoading } from "~/components/feedback/loading-skeletons";
import { Page } from "~/components/page/Page";
import { pageTitle } from "~/lib/page-title";

export const Route = createFileRoute("/_authenticated/images/")({
  head: () => ({ meta: [{ title: pageTitle("Images") }] }),
  component: ImagesPage,
});

function ImagesPage() {
  return (
    <Page variant="list" title="Images" fullWidth>
      <Suspense fallback={<SimpleLoading text="Loading images..." />}>
        <ImageList />
      </Suspense>
    </Page>
  );
}
