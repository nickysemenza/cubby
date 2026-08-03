import { createFileRoute } from "@tanstack/react-router";
import { WishList } from "~/app/wishes/wish-list";
import { Page } from "~/components/page/Page";

export const Route = createFileRoute("/_authenticated/wishes/")({
  component: WishesPage,
  head: () => ({ meta: [{ title: "Wishlist | cubby" }] }),
});

function WishesPage() {
  return (
    <Page variant="list" entity="wish" title="Wishlist" fullWidth>
      <WishList />
    </Page>
  );
}
