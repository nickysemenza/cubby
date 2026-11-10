import { createFileRoute } from "@tanstack/react-router";

import { AccountPage } from "~/features/account/account-page";
import { pageTitle } from "~/lib/page-title";

export const Route = createFileRoute("/_authenticated/account")({
  head: () => ({ meta: [{ title: pageTitle("Account") }] }),
  component: AccountPage,
});
