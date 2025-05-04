import { api } from "~/trpc/server";
import { redirect } from "next/navigation";

type UPCParams = { code: string };
type PageParams = { params: Promise<UPCParams> };

export async function generateMetadata({ params }: PageParams) {
  const code = (await params).code;
  return {
    title: `USDA UPC | ${code}`,
  };
}

export default async function Page({ params }: PageParams) {
  const code = (await params).code;
  const food = await api.usda.getByAlternateID({ kind: "upc", gtin_upc: code });
  
  if (!food) return <div>UPC {code} not found</div>;
  
  // Redirect to the standard ID-based food detail page
  redirect(`/usda/${food.fdc_id}`);
}