import { unsafeCookbookId } from "@cubby/schemas/identifiers";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { useId } from "react";
import { z } from "zod";
import { RecipeDependencyGraph } from "~/app/_components/visualizations/recipe-dependency-graph";
import { Page } from "~/components/page/Page";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { useTRPC } from "~/trpc/react";

const searchSchema = z.object({
  cookbookId: z.string().optional().catch(undefined),
  hide: z.boolean().optional().catch(true),
});

export const Route = createFileRoute("/_authenticated/recipes/graph")({
  validateSearch: searchSchema,
  component: RecipeGraphPage,
  head: () => ({ meta: [{ title: "Recipe Graph | cubby" }] }),
});

function RecipeGraphPage() {
  const { cookbookId, hide } = Route.useSearch();
  const hideUnconnected = hide ?? true;
  const navigate = useNavigate();
  const api = useTRPC();
  const hideId = useId();
  const { data: cookbooks } = useQuery(api.recipe.listCookbooks.queryOptions());

  return (
    <Page
      variant="list"
      title="Recipe dependency graph"
      actions={
        <Button
          variant="ghost"
          size="sm"
          render={<Link to="/recipes" />}
          nativeButton={false}
          className="w-fit"
        >
          <ArrowLeft className="h-4 w-4" />
          Recipes
        </Button>
      }
    >
      <div className="space-y-4">
        <p className="text-muted-foreground text-sm">
          Each arrow points from a recipe to the sub-recipe it uses as an
          ingredient. Click a node to open that recipe.
        </p>

        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Cookbook</span>
            <select
              className="h-8 rounded-md border bg-background px-2 text-sm"
              value={cookbookId ?? ""}
              onChange={(e) =>
                navigate({
                  to: "/recipes/graph",
                  search: { cookbookId: e.target.value || undefined, hide },
                })
              }
            >
              <option value="">All cookbooks</option>
              {cookbooks?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.book}
                </option>
              ))}
            </select>
          </label>
          <div className="flex items-center gap-2 text-sm">
            <Checkbox
              id={hideId}
              checked={hideUnconnected}
              onCheckedChange={(checked) =>
                navigate({
                  to: "/recipes/graph",
                  search: { cookbookId, hide: checked === true },
                })
              }
            />
            <label htmlFor={hideId} className="text-muted-foreground">
              Hide unconnected recipes
            </label>
          </div>
        </div>

        <RecipeDependencyGraph
          cookbookId={cookbookId ? unsafeCookbookId(cookbookId) : undefined}
          hideUnconnected={hideUnconnected}
        />
      </div>
    </Page>
  );
}
