import { HydrateClient } from "~/trpc/server";
import { IngredientList } from "./ingredientlist";
import { type Metadata } from "next";
import { PageWrapper } from "~/components/ui/page-wrapper";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Recipes",
};

export default function Page() {
  return (
    <HydrateClient>
      <PageWrapper>
        <IngredientList />
      </PageWrapper>
    </HydrateClient>
  );
}
