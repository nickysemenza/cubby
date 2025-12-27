import type { Metadata } from "next";
import { PageWrapper } from "~/components/layout/page-wrapper";
import { HydrateClient } from "~/trpc/server";
import { USDAFoodList } from "./usdafoodlist";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "USDA Foods",
};

export default function Page() {
  return (
    <HydrateClient>
      <PageWrapper>
        <div className="mb-6 flex items-center justify-between">
          <h1 className="font-bold text-2xl">USDA Foods</h1>
        </div>
        <USDAFoodList />
      </PageWrapper>
    </HydrateClient>
  );
}
