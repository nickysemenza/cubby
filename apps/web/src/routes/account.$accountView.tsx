import { AccountView } from "@daveyplate/better-auth-ui";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/account/$accountView")({
  component: AccountPage,
});

function AccountPage() {
  const { accountView } = Route.useParams();
  return <AccountView pathname={accountView} />;
}
