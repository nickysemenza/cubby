import { RecipeList } from "./recipelist";
import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "~/components/ui/button";
import { entities } from "~/entities/entities";
import { EntityLayout } from "~/components/layouts/entity-layout";

export const metadata: Metadata = {
  title: "Recipes",
};
export const dynamic = "force-dynamic";
export default function Page() {
  return (
    <EntityLayout
      title="Recipes"
      actions={
        <>
          <Link href={`/${entities.recipe.basePath}/new-compact`}>
            <Button variant="outline">Create New Recipe (Compact)</Button>
          </Link>
          <Link href={`/${entities.recipe.basePath}/new`}>
            <Button>Create New Recipe</Button>
          </Link>
        </>
      }
    >
      <RecipeList />
    </EntityLayout>
  );
}
