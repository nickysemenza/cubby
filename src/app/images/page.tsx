import { Suspense } from "react";
import ImageList from "./imagelist";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";

export const metadata = {
  title: "Images - RecipeHub",
  description: "Manage all uploaded images in your RecipeHub",
};

export default function ImagesPage() {
  return (
    <main className="flex-1 space-y-4 p-4 md:p-8">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight">Images</h1>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>All Images</CardTitle>
        </CardHeader>
        <CardContent>
          <Suspense fallback={<div>Loading images...</div>}>
            <ImageList />
          </Suspense>
        </CardContent>
      </Card>
    </main>
  );
}
