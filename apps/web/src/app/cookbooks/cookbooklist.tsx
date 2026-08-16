import { useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { BookOpen, EllipsisVertical } from "lucide-react";
import { VerbMenuItem } from "~/app/_components/actions/action-verb-ui";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Empty, EmptyDescription, EmptyIcon } from "~/components/ui/empty";
import { Image } from "~/components/ui/image";
import { NoneValue } from "~/components/ui/none-value";
import { entities, entityDetailParams } from "~/entities/entities";
import { useTRPC } from "~/integrations/trpc/react";
import { useCookbookDelete } from "./use-cookbook-delete";

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
  const { requestDelete, dialog } = useCookbookDelete();

  return (
    <>
      {cookbooks.length === 0 ? (
        <Empty>
          <EmptyIcon icon={BookOpen} />
          <EmptyDescription>
            No cookbooks yet. Import an EPUB from the Recipes page to get
            started.
          </EmptyDescription>
        </Empty>
      ) : (
        <ul className="my-0 ml-0 grid list-none grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {cookbooks.map(
            ({
              id,
              book,
              author,
              recipeCount,
              sourceRecipeCount,
              coverUrl,
            }) => {
              // `sourceRecipeCount` is how many recipes the EPUB extraction
              // holds; `recipeCount` is how many have actually been imported.
              // Show the partial fraction while there are still recipes to
              // import, else a plain count once everything (or more) is in.
              const allImported = sourceRecipeCount <= recipeCount;
              const countLabel = allImported
                ? `${recipeCount} ${recipeCount === 1 ? "recipe" : "recipes"}`
                : `${recipeCount} / ${sourceRecipeCount} imported`;
              const name = book || "Untitled";
              return (
                // `relative` so the overflow-menu trigger below can be an
                // absolutely-positioned SIBLING of the card Link, not a
                // descendant — a <button> nested inside an <a> is invalid
                // HTML and the anchor swallows the click.
                <li key={id} className="relative">
                  {/* Matted cover + catalog card: real cover in a hairline mat when
                      we have one, plum "cloth binding" with the serif title when not */}
                  <Link
                    to={entities.cookbook.routes.detail}
                    params={entityDetailParams(id)}
                    className="block border border-[var(--border)] bg-card p-2 transition-colors hover:bg-muted/50"
                  >
                    {coverUrl ? (
                      <Image
                        src={coverUrl}
                        alt={book}
                        displayWidth={300}
                        className="aspect-[3/4] w-full object-cover"
                      />
                    ) : (
                      <span className="flex aspect-[3/4] w-full items-center justify-center bg-plum/15 px-4 text-center">
                        <span className="line-clamp-4 font-heading font-semibold text-plum">
                          {book || <NoneValue />}
                        </span>
                      </span>
                    )}
                    <span className="eyebrow mt-2 block truncate font-medium">
                      {name}
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
                  {/* Always visible (not hover-revealed) — the app targets an
                      iOS PWA, where hover-only affordances are unreachable. */}
                  <div className="absolute top-1 right-1">
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button
                            variant="secondary"
                            size="icon"
                            className="size-6"
                            aria-label={`${name} actions`}
                          />
                        }
                      >
                        <EllipsisVertical />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <VerbMenuItem
                          verb="delete"
                          onSelect={() =>
                            requestDelete({ id, name, recipeCount })
                          }
                        />
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </li>
              );
            },
          )}
        </ul>
      )}
      {dialog}
    </>
  );
}
