import { type Metadata } from "next";
import NewRecipe from "~/app/_components/recipe/NewRecipe";
import { WasmContextProvider } from "~/wasmContext";

export const metadata: Metadata = {
  title: "New Recipe",
};

export default function Page() {
  return (
    <div>
      <h1>Hello, New Recipe Page!</h1>
      <WasmContextProvider>
        <NewRecipe />
      </WasmContextProvider>
    </div>
  );
}
