import { USDADebug } from "~/app/_components/usda/USDADebug";
import { api } from "~/trpc/server";
import { WasmContextProvider } from "~/wasmContext";

type DetailParams = { id: string };
type PageParams = { params: Promise<DetailParams> };
export async function generateMetadata({ params }: PageParams) {
  const id = parseInt((await params).id);
  return {
    title: `USDA FDC | ${id}`,
  };
}
export default async function Page({ params }: PageParams) {
  const id = parseInt((await params).id);
  const food = await api.usda.getByID({ id });
  if (!food) return <div>Not found</div>;

  return (
    <WasmContextProvider>
      <USDADebug id={id} food={food} />
    </WasmContextProvider>
  );
}
