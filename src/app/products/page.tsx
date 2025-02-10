import { HydrateClient } from "~/trpc/server";
import { ProductList } from "./productlist";
import { type Metadata } from "next";

export const metadata: Metadata = {
  title: "Recipes",
};

export default function Page() {
  return (
    <HydrateClient>
      <div>
        <ProductList />
      </div>
    </HydrateClient>
  );
}
