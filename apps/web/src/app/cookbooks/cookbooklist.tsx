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
    <ul className="my-0 ml-0 grid list-none grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
      {cookbooks.map(({ id, book, author, recipeCount, coverUrl }) => (
        <li key={id}>
          {/* Matted cover + catalog card: real cover in a hairline mat when
              we have one, plum "cloth binding" with the serif title when not */}
          <Link
            to="/cookbooks/$cookbookId"
            params={{ cookbookId: id }}
            className="block rounded-sm border border-border bg-card p-2 transition-all ease-cozy hover:-translate-y-0.5 hover:shadow-[var(--shadow-chunky-sm)]"
          >
            {coverUrl ? (
              <Image
                src={coverUrl}
                alt={book}
                className="aspect-[3/4] w-full object-cover"
              />
            ) : (
              <span className="flex aspect-[3/4] w-full items-center justify-center bg-plum/15 px-3 text-center">
                <span className="line-clamp-4 font-heading font-semibold text-plum">
                  {book || <NoneState />}
                </span>
              </span>
            )}
            <span className="mt-2 block truncate font-medium font-mono text-2xs text-eyebrow uppercase tracking-wider">
              {book || "Untitled"}
            </span>
            <span className="block truncate font-mono text-2xs text-muted-foreground uppercase tabular-nums">
              {author.length > 0 && `${author.join(", ")} · `}
              {recipeCount} {recipeCount === 1 ? "recipe" : "recipes"}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
