import { api } from "~/trpc/server";
import { LocationDetail } from "~/app/_components/locations/location-detail";
import { WasmContextProvider } from "~/wasmContext";
import { type LocationOutWithParentChildren } from "~/schemas/location";

type DetailParams = { id: string };
type PageParams = { params: Promise<DetailParams> };

export async function generateMetadata({ params }: PageParams) {
  const id = (await params).id;
  const location = await api.location.getByID({ id });
  return {
    title: `Location | ${location.name}`,
  };
}

export default async function Page({ params }: PageParams) {
  const id = (await params).id;
  const location = await api.location.getByID({ id }) as LocationOutWithParentChildren;
  return (
    <WasmContextProvider>
      <LocationDetail location={location} />
    </WasmContextProvider>
  );
}
