import { AccountView } from "@daveyplate/better-auth-ui";
import { createFileRoute } from "@tanstack/react-router";

import { Page } from "~/entity/page/page";
import { AuthUIProvider } from "~/features/auth/auth-ui-provider";
import { pageTitle } from "~/lib/page-title";

export const Route = createFileRoute("/_authenticated/account/$accountView")({
  head: () => ({ meta: [{ title: pageTitle("Account") }] }),
  component: AccountPage,
});

function AccountPage() {
  const { accountView } = Route.useParams();
  return (
    <Page variant="bare">
      <div className="mx-auto w-full max-w-3xl py-4">
        <AuthUIProvider>
          <AccountView pathname={accountView} />
        </AuthUIProvider>
      </div>
    </Page>
  );
}
