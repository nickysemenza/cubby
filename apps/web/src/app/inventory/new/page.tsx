import type { Metadata } from "next";
import CreateInventoryItem from "./new-inventory";
import { PageWrapper } from "~/components/layout/page-wrapper";

export const metadata: Metadata = {
  title: "New Inventory",
};

export default function Page() {
  return (
    <PageWrapper>
      <CreateInventoryItem />
    </PageWrapper>
  );
}
