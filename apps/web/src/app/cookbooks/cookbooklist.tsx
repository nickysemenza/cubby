import { useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { BookOpen } from "lucide-react";
import { NoneState } from "~/app/_components/NoneState";
import { Empty, EmptyDescription, EmptyIcon } from "~/components/ui/empty";
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
      <Empty>
        <EmptyIcon icon={BookOpen} />
        <EmptyDescription>
          No cookbooks yet. Import an EPUB from the Recipes page to get started.
        </EmptyDescription>
      </Empty>
    );
  }

  return (
    <ul className="my-0 ml-0 grid list-none grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
      {cookbooks.map(
        ({ id, book, author, recipeCount, sourceRecipeCount, coverUrl }) => {
          // `sourceRecipeCount` is how many recipes the EPUB extraction holds;
          // `recipeCount` is how many have actually been imported. Show the
          // partial fraction while there are still recipes to import, else a
          // plain count once everything (or more) is in.
          const allImported = sourceRecipeCount <= recipeCount;
          const countLabel = allImported
            ? `${recipeCount} ${recipeCount === 1 ? "recipe" : "recipes"}`
            : `${recipeCount} / ${sourceRecipeCount} imported`;
          return (
            <li key={id}>
              {/* Matted cover + catalog card: real cover in a hairline mat when
                  we have one, plum "cloth binding" with the serif title when not */}
              <Link
                to="/cookbooks/$cookbookId"
                params={{ cookbookId: id }}
                className="block rounded-sm border border-[var(--border)] bg-card p-2 transition-all ease-cozy hover:-translate-y-0.5 hover:shadow-[var(--shadow-chunky-sm)]"
              >
                {coverUrl ? (
                  <Image
                    src={coverUrl}
                    alt={book}
                    className="aspect-[3/4] w-full object-cover"
                  />
                ) : (
                  <span className="flex aspect-[3/4] w-full items-center justify-center bg-plum/15 px-4 text-center">
                    <span className="line-clamp-4 font-heading font-semibold text-plum">
                      {book || <NoneState />}
                    </span>
                  </span>
                )}
                <span className="eyebrow mt-2 block truncate font-medium">
                  {book || "Untitled"}
                </span>
                {author.length > 0 && (
                  <span className="block truncate font-mono text-2xs text-muted-foreground uppercase">
                    {author.join(", ")}
                  </span>
                )}
                <span className="block font-mono text-2xs text-muted-foreground uppercase tabular-nums">
                  {countLabel}
                </span>
              </Link>
            </li>
          );
        },
      )}
    </ul>
  );
}
