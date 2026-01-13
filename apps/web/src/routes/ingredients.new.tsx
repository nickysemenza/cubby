import { createFileRoute } from "@tanstack/react-router";
import { NewEntityPage } from "~/components/entity/new-entity-page";
import { PageWrapper } from "~/components/layout/page-wrapper";
import { authMiddleware } from "~/lib/protected-route";

export const Route = createFileRoute("/ingredients/new")({
  component: NewIngredientPage,
  server: {
    middleware: [authMiddleware],
  },
});

function NewIngredientPage() {
  return (
    <PageWrapper>
      <NewEntityPage entity="ingredient" />
    </PageWrapper>
  );
}
