import { redirect } from "next/navigation";
import { api } from "~/trpc/server";

type NDBParams = { code: string };
type PageParams = { params: Promise<NDBParams> };

export async function generateMetadata({ params }: PageParams) {
  const code = (await params).code;
  return {
    title: `USDA NDB | ${code}`,
  };
}

export default async function Page({ params }: PageParams) {
  const code = (await params).code;
  const ndbNumber = parseInt(code, 10);

  if (Number.isNaN(ndbNumber)) {
    return <div>Invalid NDB number: {code}</div>;
  }

  const food = await api.usda.getByAlternateID({
    kind: "ndb",
    ndb_number: ndbNumber,
  });

  if (!food) return <div>NDB {code} not found</div>;

  // Redirect to the standard ID-based food detail page
  redirect(`/usda/${food.fdc_id}`);
}
