import { NewProduct } from "~/app/_components/products/new-product";
import { PageWrapper } from "~/components/layout/page-wrapper";

export const metadata = {
  title: "Create New Product",
};

export default function NewProductPage() {
  return (
    <PageWrapper>
      <NewProduct />
    </PageWrapper>
  );
}
