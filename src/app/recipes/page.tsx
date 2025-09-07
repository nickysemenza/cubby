import { HydrateClient } from "~/trpc/server";
import { RecipeList } from "./recipelist";
import { type Metadata } from "next";
import Link from "next/link";
import { Button } from "~/components/ui/button";
import { entities } from "~/entities/entities";
import { PageWrapper } from "~/components/ui/page-wrapper";

export const metadata: Metadata = {
  title: "Recipes",
};
export const dynamic = "force-dynamic";
export default function Page() {
  return (
    <HydrateClient>
      <PageWrapper>
        <div className="my-2 flex flex-row">
          <Link href={`/${entities.recipe.basePath}/new-compact`}>
            <Button>Create New Recipe (Compact)</Button>
          </Link>
          <Link href={`/${entities.recipe.basePath}/new`}>
            <Button>Create New Recipe</Button>
          </Link>
        </div>
        <RecipeList />
      </PageWrapper>
    </HydrateClient>
  );
}
