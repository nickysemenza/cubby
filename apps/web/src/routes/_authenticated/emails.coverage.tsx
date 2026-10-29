import { mailCoverageView } from "@cubby/schemas/mail-coverage";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { ensureEntityMetadata } from "~/entity/metadata";
import { Page } from "~/entity/page/page";
import { MailCoveragePage } from "~/features/email/mail-coverage";
import { pageTitle } from "~/lib/page-title";

const searchSchema = z.object({
  vendor: z.string().optional(),
  mailbox: z.string().optional(),
  account: z.string().optional(),
  view: mailCoverageView.default("all"),
});

export const Route = createFileRoute("/_authenticated/emails/coverage")({
  validateSearch: searchSchema,
  beforeLoad: async ({ context }) => {
    // Disclosed Email rows and receipt evidence must work without a prior entity-page visit.
    await Promise.all(
      (["email", "vendor", "vendorAccount", "purchase", "run"] as const).map(
        (entity) => ensureEntityMetadata(context.queryClient, entity),
      ),
    );
  },
  head: () => ({ meta: [{ title: pageTitle("Mail coverage") }] }),
  component: CoverageRoute,
});

function CoverageRoute() {
  const navigate = Route.useNavigate();
  const { vendor, mailbox, account, view } = Route.useSearch();
  return (
    <Page variant="list" title="Mail coverage" layout="full">
      <MailCoveragePage
        vendorId={vendor}
        mailboxId={mailbox}
        accountId={account}
        view={view}
        onViewChange={(next) =>
          void navigate({
            search: (previous) => ({ ...previous, view: next }),
            replace: true,
          })
        }
      />
    </Page>
  );
}
