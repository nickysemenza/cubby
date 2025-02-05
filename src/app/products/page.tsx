import { HydrateClient } from "~/trpc/server";
import { ItemList } from "../_components/itemlist";
import { type Metadata } from "next";

export const metadata: Metadata = {
  title: "Recipes",
};

export default function Page() {
  return (
    <HydrateClient>
      <div>
        <h1>Hello, Dashboard Page!</h1>
        <ItemList />
      </div>
    </HydrateClient>
  );
}
