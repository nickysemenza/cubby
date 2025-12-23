import { api } from "~/trpc/server";
import { ProductDetail } from "~/app/_components/products/product-detail";
import { PageWrapper } from "~/components/layout/page-wrapper";

type DetailParams = { id: string };
type PageParams = { params: Promise<DetailParams> };

export async function generateMetadata({ params }: PageParams) {
  const id = (await params).id;
  const product = await api.product.getByID({ id });
  return {
    title: `Product | ${product.name}`,
  };
}

export default async function Page({ params }: PageParams) {
  const id = (await params).id;
  const product = await api.product.getByID({ id });
  return (
    <PageWrapper>
      <ProductDetail product={product} />
    </PageWrapper>
  );
}
