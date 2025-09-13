import { USDAFoodDetail } from "~/app/_components/usda/USDAFoodDetail";
import { api } from "~/trpc/server";
import { PageWrapper } from "~/components/ui/page-wrapper";

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
    <PageWrapper>
      <USDAFoodDetail id={id} food={food} />
    </PageWrapper>
  );
}
