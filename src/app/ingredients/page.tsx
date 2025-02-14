import { HydrateClient } from "~/trpc/server";
import { IngredientList } from "./ingredientlist";
import { type Metadata } from "next";
import { WasmContextProvider } from "~/wasmContext";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Recipes",
};

export default function Page() {
  return (
    <HydrateClient>
      <div className="container mx-auto">
        <WasmContextProvider>
          <IngredientList />
        </WasmContextProvider>
      </div>
    </HydrateClient>
  );
}
