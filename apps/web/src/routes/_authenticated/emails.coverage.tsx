import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { Page } from "~/entity/page/page";
import { MailCoveragePage } from "~/features/email/mail-coverage";
import { pageTitle } from "~/lib/page-title";

const searchSchema = z.object({
  vendor: z.string().optional(),
  mailbox: z.string().optional(),
  account: z.string().optional(),
});

export const Route = createFileRoute("/_authenticated/emails/coverage")({
  validateSearch: searchSchema,
  head: () => ({ meta: [{ title: pageTitle("Mail coverage") }] }),
  component: CoverageRoute,
});

function CoverageRoute() {
  const { vendor, mailbox, account } = Route.useSearch();
  return (
    <Page variant="list" title="Mail coverage" layout="full">
      <MailCoveragePage
        vendorId={vendor}
        mailboxId={mailbox}
        accountId={account}
      />
    </Page>
  );
}
