import { Suspense } from "react";
import ImageList from "./imagelist";
import { PageWrapper } from "~/components/layout/page-wrapper";
import { SimpleLoading } from "~/components/feedback/loading-skeletons";

export const metadata = {
  title: "Images - RecipeHub",
  description: "Manage all uploaded images in your RecipeHub",
};

export default function ImagesPage() {
  return (
    <PageWrapper>
      <Suspense fallback={<SimpleLoading text="Loading images..." />}>
        <ImageList />
      </Suspense>
    </PageWrapper>
  );
}
