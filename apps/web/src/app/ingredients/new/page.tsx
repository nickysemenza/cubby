import { NewIngredient } from "~/app/_components/ingredients/new-ingredient";
import { PageWrapper } from "~/components/layout/page-wrapper";

export const metadata = {
  title: "Create New Ingredient",
};

export default function NewIngredientPage() {
  return (
    <PageWrapper>
      <NewIngredient />
    </PageWrapper>
  );
}
