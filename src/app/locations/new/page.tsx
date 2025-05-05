import { NewLocation } from "~/app/_components/locations/new-location";
import { WasmContextProvider } from "~/wasmContext";

export const metadata = {
  title: "Create New Location",
};

export default function NewLocationPage() {
  return (
    <WasmContextProvider>
      <NewLocation />
    </WasmContextProvider>
  );
}