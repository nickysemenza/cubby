import { createFileRoute } from "@tanstack/react-router";
import { USDAFoodList } from "~/app/usda/usdafoodlist";
import { PageWrapper } from "~/components/layout/page-wrapper";

export const Route = createFileRoute("/usda/")({
  component: USDAPage,
});

function USDAPage() {
  return (
    <PageWrapper>
      <div className="fade-in mb-6 flex animate-in items-center justify-between duration-300">
        <h1 className="font-bold font-heading text-2xl">USDA Foods</h1>
      </div>
      <USDAFoodList />
    </PageWrapper>
  );
}
