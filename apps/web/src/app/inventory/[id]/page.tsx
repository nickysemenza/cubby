import { api } from "~/trpc/server";
import { InventoryDetail } from "~/app/_components/inventory/inventory-detail";
import { PageWrapper } from "~/components/ui/page-wrapper";

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
    <PageWrapper>
      <InventoryDetail inventoryitem={inventoryitem} />
    </PageWrapper>
  );
}
