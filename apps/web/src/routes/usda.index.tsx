import { createFileRoute } from "@tanstack/react-router";
import { USDAFoodList } from "~/app/usda/usdafoodlist";
import { PageWrapper } from "~/components/layout/page-wrapper";

export const Route = createFileRoute("/usda/")({
  component: USDAPage,
});

function USDAPage() {
  return (
    <PageWrapper>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="font-bold text-2xl">USDA Foods</h1>
      </div>
      <USDAFoodList />
    </PageWrapper>
  );
}
