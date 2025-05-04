import { type Metadata } from "next";
import { WasmContextProvider } from "~/wasmContext";
import CreateInventoryItem from "./new-inventory";

export const metadata: Metadata = {
  title: "New Inventory",
};

export default function Page() {
  return (
    <div>
      <WasmContextProvider>
        <CreateInventoryItem />
      </WasmContextProvider>
    </div>
  );
}
