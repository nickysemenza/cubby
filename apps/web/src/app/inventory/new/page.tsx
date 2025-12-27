import type { Metadata } from "next";
import { PageWrapper } from "~/components/layout/page-wrapper";
import CreateInventoryItem from "./new-inventory";

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
