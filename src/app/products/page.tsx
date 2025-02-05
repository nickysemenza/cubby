import { HydrateClient } from "~/trpc/server";
import { ProductList } from "../_components/productlist";
import { type Metadata } from "next";

export const metadata: Metadata = {
  title: "Recipes",
};

export default function Page() {
  return (
    <HydrateClient>
      <div>
        <h1>Hello, Dashboard Page!</h1>
        <ProductList />
      </div>
    </HydrateClient>
  );
}
