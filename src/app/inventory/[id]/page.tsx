import JsonRenderer from "~/app/_components/json";
import { api } from "~/trpc/server";

type DetailParams = { id: string };
type PageParams = { params: Promise<DetailParams> };
export async function generateMetadata({ params }: PageParams) {
  const id = (await params).id;
  const inventoryitem = await api.inventoryItem.getByID({ id });
  return {
    title: `InventoryItem | ${inventoryitem.id}`,
  };
}
export default async function Page({ params }: PageParams) {
  const id = (await params).id;
  const inventoryitem = await api.inventoryItem.getByID({ id });
  return (
    <div>
      <JsonRenderer input={inventoryitem} />
    </div>
  );
}
