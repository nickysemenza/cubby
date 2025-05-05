import { NewProduct } from "~/app/_components/products/new-product";
import { WasmContextProvider } from "~/wasmContext";

export const metadata = {
  title: "Create New Product",
};

export default function NewProductPage() {
  return (
    <WasmContextProvider>
      <NewProduct />
    </WasmContextProvider>
  );
}
