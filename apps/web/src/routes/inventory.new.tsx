import { createFileRoute } from "@tanstack/react-router";
import CreateInventoryItem from "~/app/inventory/new/new-inventory";
import { PageWrapper } from "~/components/layout/page-wrapper";
import { authMiddleware } from "~/lib/protected-route";

export const Route = createFileRoute("/inventory/new")({
  component: NewInventoryPage,
  server: {
    middleware: [authMiddleware],
  },
});

function NewInventoryPage() {
  return (
    <PageWrapper>
      <CreateInventoryItem />
    </PageWrapper>
  );
}
