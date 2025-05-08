import { HydrateClient } from "~/trpc/server";
import { RecipeList } from "./recipelist";
import { type Metadata } from "next";
import Link from "next/link";
import { Button } from "~/components/ui/button";

export const metadata: Metadata = {
  title: "Recipes",
};
export const dynamic = "force-dynamic";
export default function Page() {
  return (
    <HydrateClient>
      <div>
        <div className="my-2 flex flex-row">
          <Link href="/recipes/new-compact">
            <Button>Create New Recipe (Compact)</Button>
          </Link>
          <Link href="/recipes/new">
            <Button>Create New Recipe</Button>
          </Link>
        </div>
        <RecipeList />
      </div>
    </HydrateClient>
  );
}
