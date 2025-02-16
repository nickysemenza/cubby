import { type Metadata } from "next";
import NewRecipe from "~/app/_components/recipe/NewRecipe";
import { WasmContextProvider } from "~/wasmContext";

export const metadata: Metadata = {
  title: "New Recipe",
};

export default function Page() {
  return (
    <div>
      <WasmContextProvider>
        <NewRecipe />
      </WasmContextProvider>
    </div>
  );
}
