/**
 * Shortcode landing route — the compact URL a QR label or a typed code lands on.
 *
 * Handles `/LOC-A3F2`, `/PRD-X7K9`, and every other prefix, plus the pre-cutover
 * single-letter forms (`/L-A3F2`) that are printed on labels already stuck to
 * things. `parseShortcode` canonicalizes those, so a legacy scan ends up at the
 * same canonical URL as a fresh one — never at a uuid.
 *
 * Every recognized code redirects to its entity-scoped canonical detail URL.
 * The prefix alone names the entity; the detail route owns lookup and 404s.
 */

import { parseShortcode } from "@cubby/shared";
import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { RouteErrorComponent } from "~/components/lazy-route-error";
import { Page } from "~/components/page/Page";
import { DetailPagePending } from "~/components/route-pending";
import { Empty, EmptyDescription, EmptyTitle } from "~/components/ui/empty";
import { entities, entityDetailParams } from "~/entities/entities";
import { shortcodeHead } from "~/lib/page-title";

export const Route = createFileRoute("/_authenticated/$shortcode")({
  loader: ({ params }) => {
    const parsed = parseShortcode(params.shortcode);
    if (!parsed) throw notFound();

    throw redirect({
      to: entities[parsed.type].routes.detail,
      params: entityDetailParams(parsed.shortcode),
      replace: true,
    });
  },
  pendingComponent: DetailPagePending,
  errorComponent: RouteErrorComponent,
  notFoundComponent: () => (
    <Page variant="list" title="Not found" compact>
      <Empty>
        <EmptyTitle>Nothing found for that code</EmptyTitle>
        <EmptyDescription>
          This QR label doesn't match anything in Cubby.
        </EmptyDescription>
      </Empty>
    </Page>
  ),
  head: shortcodeHead,
});
