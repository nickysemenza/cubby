import { Suspense } from "react";
import ImageList from "./imagelist";

export const metadata = {
  title: "Images - RecipeHub",
  description: "Manage all uploaded images in your RecipeHub",
};

export default function ImagesPage() {
  return (
    <Suspense fallback={<div>Loading images...</div>}>
      <ImageList />
    </Suspense>
  );
}
