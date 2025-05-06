import { type Metadata } from "next";
import NewCompactRecipe from "~/app/_components/recipe/NewCompactRecipe";
import { WasmContextProvider } from "~/wasmContext";

export const metadata: Metadata = {
  title: "New Recipe",
};

export default function Page() {
  return (
    <div>
      <WasmContextProvider>
        <NewCompactRecipe />
      </WasmContextProvider>
    </div>
  );
}
