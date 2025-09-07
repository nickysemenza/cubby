import { HydrateClient } from "~/trpc/server";
import { ProductList } from "./productlist";
import { type Metadata } from "next";
import Link from "next/link";
import { Button } from "~/components/ui/button";
import { entities } from "~/entities/entities";
import { PageWrapper } from "~/components/ui/page-wrapper";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Products",
};

export default function Page() {
  return (
    <HydrateClient>
      <PageWrapper>
        <div className="mb-6 flex items-center justify-between">
          <h1 className="text-2xl font-bold">Products</h1>
          <Link href={`/${entities.product.basePath}/new`}>
            <Button>Create New Product</Button>
          </Link>
        </div>
        <ProductList />
      </PageWrapper>
    </HydrateClient>
  );
}
