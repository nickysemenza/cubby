import { USDAFoodDetail } from "~/app/_components/usda/USDAFoodDetail";
import { PageWrapper } from "~/components/layout/page-wrapper";
import { api } from "~/trpc/server";

type DetailParams = { id: string };
type PageParams = { params: Promise<DetailParams> };
export async function generateMetadata({ params }: PageParams) {
  const id = parseInt((await params).id, 10);
  return {
    title: `USDA FDC | ${id}`,
  };
}
export default async function Page({ params }: PageParams) {
  const id = parseInt((await params).id, 10);
  const food = await api.usda.getByID({ id });
  if (!food) return <div>Not found</div>;

  return (
    <PageWrapper>
      <USDAFoodDetail id={id} food={food} />
    </PageWrapper>
  );
}
