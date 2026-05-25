import { createFileRoute } from "@tanstack/react-router";
import { USDAFoodList } from "~/app/usda/usdafoodlist";
import { PageWrapper } from "~/components/layout/page-wrapper";
import { PageHero } from "~/components/layouts/page-hero";

export const Route = createFileRoute("/_authenticated/usda/")({
  component: USDAPage,
});

function USDAPage() {
  return (
    <PageWrapper>
      <div className="fade-in animate-in duration-300">
        <PageHero variant="list" entity="usda-food" title="USDA Foods" />
      </div>
      <USDAFoodList />
    </PageWrapper>
  );
}
