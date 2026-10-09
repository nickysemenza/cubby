import { AccountView } from "@daveyplate/better-auth-ui";
import { createFileRoute } from "@tanstack/react-router";

import { AuthUIProvider } from "~/app/auth/auth-ui-provider";
import { pageTitle } from "~/lib/page-title";

export const Route = createFileRoute("/_authenticated/account/$accountView")({
  head: () => ({ meta: [{ title: pageTitle("Account") }] }),
  component: AccountPage,
});

function AccountPage() {
  const { accountView } = Route.useParams();
  return (
    <AuthUIProvider>
      <AccountView pathname={accountView} />
    </AuthUIProvider>
  );
}
