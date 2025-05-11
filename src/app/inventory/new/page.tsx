import { type Metadata } from "next";
import CreateInventoryItem from "./new-inventory";

export const metadata: Metadata = {
  title: "New Inventory",
};

export default function Page() {
  return (
    <div>
      <CreateInventoryItem />
    </div>
  );
}
