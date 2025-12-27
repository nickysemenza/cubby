import { ProductList } from "./productlist";
import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "~/components/ui/button";
import { entities } from "~/entities/entities";
import { EntityLayout } from "~/components/layouts/entity-layout";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Products",
};

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ category?: string }>;
}) {
  const { category } = await searchParams;

  return (
    <EntityLayout
      title="Products"
      actions={
        <Link href={`/${entities.product.basePath}/new`}>
          <Button>Create New Product</Button>
        </Link>
      }
    >
      <ProductList initialCategory={category} />
    </EntityLayout>
  );
}
