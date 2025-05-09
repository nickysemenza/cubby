import { NewIngredient } from "~/app/_components/ingredients/new-ingredient";
import { WasmContextProvider } from "~/wasmContext";

export const metadata = {
  title: "Create New Ingredient",
};

export default function NewIngredientPage() {
  return (
    <WasmContextProvider>
      <NewIngredient />
    </WasmContextProvider>
  );
}
