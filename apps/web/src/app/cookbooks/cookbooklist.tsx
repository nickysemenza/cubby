import { useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { BookOpen } from "lucide-react";
import { NoneState } from "~/app/_components/NoneState";
import { Image } from "~/components/ui/image";
import { useTRPC } from "~/trpc/react";

/**
 * Browse-by-source index: every cookbook a recipe was imported from, with its
 * author and recipe count. Backed by the `Cookbook` table (`recipe.listCookbooks`).
 * Each card links to the cookbook detail page, which lists that book's recipes.
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
    <ul className="my-0 ml-0 grid list-none grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {cookbooks.map(({ id, book, author, recipeCount, coverUrl }) => (
        <li key={id}>
          <Link
            to="/cookbooks/$cookbookId"
            params={{ cookbookId: id }}
            className="flex items-center gap-3 rounded-lg border border-border bg-card p-4 shadow-[var(--shadow-chunky-sm)] transition-all ease-cozy hover:-translate-y-0.5 hover:bg-muted/50 hover:shadow-[var(--shadow-chunky)]"
          >
            {coverUrl ? (
              <Image
                src={coverUrl}
                alt={book}
                className="h-14 w-10 shrink-0 rounded-md object-cover"
              />
            ) : (
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-plum/20 text-plum">
                <BookOpen className="h-5 w-5" />
              </span>
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate font-heading font-semibold">
                {book || <NoneState />}
              </span>
              {author.length > 0 && (
                <span className="block truncate text-muted-foreground text-sm">
                  {author.join(", ")}
                </span>
              )}
              <span className="block font-mono text-2xs text-muted-foreground uppercase tabular-nums">
                {recipeCount} {recipeCount === 1 ? "recipe" : "recipes"}
              </span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
