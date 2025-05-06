import { HydrateClient } from "~/trpc/server";
import { RecipeList } from "./recipelist";
import { type Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Recipes",
};
export const dynamic = "force-dynamic";
export default function Page() {
  return (
    <HydrateClient>
      <div>
        <Link
          href="/recipes/new-compact"
          className="text-blue-600 hover:underline"
        >
          New Compact
        </Link>
        <RecipeList />
      </div>
    </HydrateClient>
  );
}
