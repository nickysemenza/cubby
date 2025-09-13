import { InventoryItemList } from "./inventoryitemlist";
import { type Metadata } from "next";
import Link from "next/link";
import { Button } from "~/components/ui/button";
import { entities } from "~/entities/entities";
import { EntityLayout } from "~/components/layouts/entity-layout";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Inventory Items",
};

export default function Page() {
  return (
    <EntityLayout
      title="Inventory Items"
      actions={
        <>
          <Link href={`/${entities["inventory-item"].basePath}/bulk-edit`}>
            <Button variant="outline">Bulk Edit</Button>
          </Link>
          <Link href={`/${entities["inventory-item"].basePath}/new`}>
            <Button>Create New</Button>
          </Link>
        </>
      }
    >
      <InventoryItemList />
    </EntityLayout>
  );
}
