import { HydrateClient } from "~/trpc/server";
import { RecipeList } from "../_components/recipelist";
import { type Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Recipes",
};

export default function Page() {
  return (
    <HydrateClient>
      <div>
        <Link href="/recipes/new" className="text-blue-600 hover:underline">
          New
        </Link>
        <RecipeList />
      </div>
    </HydrateClient>
  );
}
