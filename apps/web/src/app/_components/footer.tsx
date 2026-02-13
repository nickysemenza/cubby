import type { SortParams } from "@cubby/schemas/pagination";
import { useQueries } from "@tanstack/react-query";
import { Github } from "lucide-react";
import { authClient } from "~/lib/auth-client";
import { useTRPC } from "~/trpc/react";

const buildDateFormatter = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
});

const buildDate = buildDateFormatter.format(new Date(__BUILD_DATE__));

function EntityCounts() {
  const api = useTRPC();
  const session = authClient.useSession();
  const isAuthenticated = !!session.data?.user;

  const sort: SortParams = { orderBy: "name", direction: "asc" };
  const opts = {
    filters: {},
    sort,
    pagination: { pageIndex: 0, pageSize: 1 },
  };

  const { counts, isLoading } = useQueries({
    queries: [
      { ...api.product.list.queryOptions(opts), enabled: isAuthenticated },
      { ...api.location.list.queryOptions(opts), enabled: isAuthenticated },
      { ...api.recipe.list.queryOptions(opts), enabled: isAuthenticated },
      { ...api.ingredient.list.queryOptions(opts), enabled: isAuthenticated },
    ],
    combine: (results) => ({
      counts: results.map((r) => r.data?.meta.totalCount),
      isLoading: results.some((r) => r.isLoading),
    }),
  });

  if (!isAuthenticated || isLoading) return null;

  const [products, locations, recipes, ingredients] = counts;
  const parts = [
    products != null && `${products} products`,
    locations != null && `${locations} locations`,
    recipes != null && `${recipes} recipes`,
    ingredients != null && `${ingredients} ingredients`,
  ].filter(Boolean);

  if (parts.length === 0) return null;

  return <span>{parts.join(" · ")}</span>;
}

export function AppFooter() {
  return (
    <footer className="hidden border-t md:block">
      <div className="mx-auto flex w-full max-w-7xl items-center justify-between px-4 py-2 text-muted-foreground text-xs md:px-6">
        <div className="flex items-center gap-3">
          <span>
            {buildDate} ·{" "}
            <span title={__GIT_COMMIT_MSG__}>{__GIT_COMMIT__}</span>
          </span>
          <EntityCounts />
        </div>
        <div className="flex items-center gap-3">
          <span className="text-muted-foreground/60">⌘K to search</span>
          <a
            href="https://github.com/nickysemenza/recipehub"
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted-foreground transition-colors hover:text-foreground"
          >
            <Github className="h-3.5 w-3.5" />
          </a>
        </div>
      </div>
    </footer>
  );
}
