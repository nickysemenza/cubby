import type { ReactNode } from "react";

import { Page } from "~/components/page/Page";

/**
 * Shell for the two consent-screen pages. Deliberately plain: these render for
 * signed-out visitors and for Google's review, so they use no app chrome,
 * no data fetching and no auth-dependent state.
 */
export function LegalPage({
  title,
  updated,
  children,
}: {
  title: string;
  updated: string;
  children: ReactNode;
}) {
  return (
    <Page variant="bare">
      <article className="mx-auto max-w-prose space-y-4 px-4 py-10 text-sm leading-relaxed [&_a]:underline">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold">{title}</h1>
          <p className="text-muted-foreground">Last updated {updated}</p>
        </header>
        {children}
      </article>
    </Page>
  );
}
