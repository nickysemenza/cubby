import { HydrateClient } from "~/trpc/server";
import { ProductList } from "./productlist";
import { type Metadata } from "next";
import { WasmContextProvider } from "~/wasmContext";
export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Recipes",
};

export default function Page() {
  return (
    <HydrateClient>
      <div>
        <WasmContextProvider>
          <ProductList />
        </WasmContextProvider>
      </div>
    </HydrateClient>
  );
}
