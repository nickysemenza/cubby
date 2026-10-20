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
import {
  createFileRoute,
  Link,
  notFound,
  redirect,
} from "@tanstack/react-router";

import {
  entities,
  entityDetailParams,
  isBrowserRoutedEntity,
} from "~/entity/entities";
import { DetailPagePending } from "~/entity/navigation/route-pending";
import { Page } from "~/entity/page/page";
import { shortcodeHead } from "~/lib/page-title";
import { EmptyState } from "~/ui/feedback/empty-state";
import { RouteErrorComponent } from "~/ui/feedback/route-error";
import { Button } from "~/ui/primitives/button";

export const Route = createFileRoute("/_authenticated/$shortcode")({
  loader: ({ params }) => {
    const parsed = parseShortcode(params.shortcode);
    if (!parsed || !isBrowserRoutedEntity(parsed.type)) throw notFound();

    throw redirect({
      to: entities[parsed.type].routes.detail,
      params: entityDetailParams(parsed.shortcode),
      search: (previous) => previous,
      replace: true,
    });
  },
  pendingComponent: DetailPagePending,
  errorComponent: RouteErrorComponent,
  notFoundComponent: () => (
    <Page variant="list" title="Not found">
      <EmptyState
        size="page"
        description="This QR label doesn't match anything in Cubby."
        action={
          <>
            <Button
              variant="outline"
              render={<Link to="/" />}
              nativeButton={false}
            >
              Back to Today
            </Button>
          </>
        }
      >
        Nothing found for that code
      </EmptyState>
    </Page>
  ),
  head: shortcodeHead,
});
