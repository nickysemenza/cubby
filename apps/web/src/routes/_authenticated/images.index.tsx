import { createFileRoute } from "@tanstack/react-router";
import { Suspense } from "react";
import ImageList from "~/app/images/imagelist";
import { SimpleLoading } from "~/components/feedback/loading-skeletons";
import { Page } from "~/components/page/Page";

export const Route = createFileRoute("/_authenticated/images/")({
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
