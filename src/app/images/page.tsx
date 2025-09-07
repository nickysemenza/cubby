import { Suspense } from "react";
import ImageList from "./imagelist";
import { PageWrapper } from "~/components/ui/page-wrapper";

export const metadata = {
  title: "Images - RecipeHub",
  description: "Manage all uploaded images in your RecipeHub",
};

export default function ImagesPage() {
  return (
    <PageWrapper>
      <Suspense fallback={<div>Loading images...</div>}>
        <ImageList />
      </Suspense>
    </PageWrapper>
  );
}
