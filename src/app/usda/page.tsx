import { HydrateClient } from "~/trpc/server";
import { USDAFoodList } from "./usdafoodlist";
import { type Metadata } from "next";
import { WasmContextProvider } from "~/wasmContext";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "USDA Foods",
};

export default function Page() {
  return (
    <HydrateClient>
      <div className="container mx-auto py-10">
        <div className="flex justify-between items-center mb-6">
          <h1 className="text-2xl font-bold">USDA Foods</h1>
        </div>
        <WasmContextProvider>
          <USDAFoodList />
        </WasmContextProvider>
      </div>
    </HydrateClient>
  );
}