import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";

import { DEFAULT_TITLE, pageTitle, TITLE_SEPARATOR } from "~/lib/page-title";

/**
 * The title the router's `head` meta currently wants, deepest match first.
 *
 * Mirrors the precedence in TanStack's `headContentUtils` (walk matches from
 * the leaf up, first `meta.title` wins) so the imperative path and the rendered
 * `<title>` element can never disagree.
 */
const routerTitle = (matches: ReadonlyArray<{ meta?: unknown }>): string => {
  for (let i = matches.length - 1; i >= 0; i--) {
    const meta = matches[i]?.meta;
    if (!Array.isArray(meta)) continue;
    for (let j = meta.length - 1; j >= 0; j--) {
      const title = (meta[j] as { title?: unknown } | undefined)?.title;
      if (typeof title === "string" && title) return title;
    }
  }
  return DEFAULT_TITLE;
};

/**
 * Updates the document title for a route whose title isn't known until a client
 * query resolves (every `ssr: false` detail route).
 *
 * On unmount it restores the title the ROUTER currently wants — deliberately
 * not a snapshot captured when the effect ran. That snapshot was the bug: a
 * detail page captured whatever was in the `<title>` node at effect time (the
 * root default, "Cubby"), and React runs an unmounting component's effect
 * cleanup AFTER it has already committed the incoming route's `<title>`. So
 * navigating detail → list wrote "Cubby" over a correct "Products | cubby",
 * and nothing re-asserted it — the tab stayed wrong until a hard refresh.
 *
 * Re-deriving at cleanup time is correct because the router store already holds
 * the INCOMING matches by the time cleanup runs.
 */
export const useDocumentTitle = (title: string | undefined) => {
  const router = useRouter();

  useEffect(() => {
    if (!title) return;
    document.title = pageTitle(title);
    return () => {
      document.title = routerTitle(router.state.matches);
    };
  }, [title, router]);
};

/**
 * Detail-page title: `PRD-4K7M · Packout Tool Box | cubby`.
 *
 * While `name` is undefined this writes nothing, so the route's own
 * `shortcodeHead` title (`PRD-4K7M | cubby`) stands for the pending window
 * rather than falling back to the bare root default.
 */
export const useDetailTitle = (
  shortcode: string,
  name: string | undefined | null,
) => {
  useDocumentTitle(name ? `${shortcode}${TITLE_SEPARATOR}${name}` : undefined);
};
