import { useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { BookOpen } from "lucide-react";
import { NoneState } from "~/app/_components/NoneState";
import { useTRPC } from "~/trpc/react";

/**
 * Browse-by-source index: every cookbook a recipe was imported from, with its
 * recipe count. Cookbooks aren't a DB entity — this is `recipe.listCookbooks`
 * grouping Book recipes by their `SourceData` name. Each card links to the
 * cookbook detail page, which lists that book's recipes.
 */
export function CookbookList() {
  const api = useTRPC();
  const { data: cookbooks } = useSuspenseQuery(
    api.recipe.listCookbooks.queryOptions(),
  );

  if (cookbooks.length === 0) {
    return (
      <div className="rounded-xl border border-border border-dashed p-10 text-center text-muted-foreground">
        <BookOpen className="mx-auto mb-3 h-6 w-6" />
        <p className="text-sm">
          No cookbooks yet. Import an EPUB from the Recipes page to get started.
        </p>
      </div>
    );
  }

  return (
    <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {cookbooks.map(({ book, recipeCount }) => (
        <li key={book}>
          <Link
            to="/cookbooks/$book"
            params={{ book }}
            className="flex items-center gap-3 rounded-lg border border-border bg-card p-4 transition-colors hover:border-foreground/30 hover:bg-muted/50"
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-plum/20 text-plum">
              <BookOpen className="h-5 w-5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">
                {book || <NoneState />}
              </span>
              <span className="block text-muted-foreground text-sm">
                {recipeCount} {recipeCount === 1 ? "recipe" : "recipes"}
              </span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
