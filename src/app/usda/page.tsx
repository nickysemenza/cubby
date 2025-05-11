import { HydrateClient } from "~/trpc/server";
import { USDAFoodList } from "./usdafoodlist";
import { type Metadata } from "next";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "USDA Foods",
};

export default function Page() {
  return (
    <HydrateClient>
      <div className="container mx-auto py-10">
        <div className="mb-6 flex items-center justify-between">
          <h1 className="text-2xl font-bold">USDA Foods</h1>
        </div>
        <USDAFoodList />
      </div>
    </HydrateClient>
  );
}
