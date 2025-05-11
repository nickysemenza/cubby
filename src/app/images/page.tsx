"use client";

import { Suspense } from "react";
import ImageList from "./imagelist";
import {
  DetailPage,
  type DetailSection,
} from "~/app/_components/data-table/detail-page";

export const metadata = {
  title: "Images - RecipeHub",
  description: "Manage all uploaded images in your RecipeHub",
};

export default function ImagesPage() {
  const sections: DetailSection[] = [
    {
      title: "All Images",
      content: (
        <Suspense fallback={<div>Loading images...</div>}>
          <ImageList />
        </Suspense>
      ),
    },
  ];

  return <DetailPage sections={sections} entity="image" name="List" />;
}
