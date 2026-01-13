import { createFileRoute } from "@tanstack/react-router";
import { Suspense } from "react";
import ImageList from "~/app/images/imagelist";
import { SimpleLoading } from "~/components/feedback/loading-skeletons";
import { PageWrapper } from "~/components/layout/page-wrapper";
import { authMiddleware } from "~/lib/protected-route";

export const Route = createFileRoute("/images/")({
  component: ImagesPage,
  server: {
    middleware: [authMiddleware],
  },
});

function ImagesPage() {
  return (
    <PageWrapper>
      <Suspense fallback={<SimpleLoading text="Loading images..." />}>
        <ImageList />
      </Suspense>
    </PageWrapper>
  );
}
