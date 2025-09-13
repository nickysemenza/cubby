import { type Metadata } from "next";
import NewCompactRecipe from "~/app/_components/recipe/NewCompactRecipe";
import { PageWrapper } from "~/components/ui/page-wrapper";

export const metadata: Metadata = {
  title: "New Recipe",
};

export default function Page() {
  return (
    <PageWrapper>
      <NewCompactRecipe />
    </PageWrapper>
  );
}
