import { unsafeCookbookId } from "@cubby/schemas/identifiers";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useId } from "react";
import { z } from "zod";
import { EntityManifestGrid } from "~/app/_components/entities/EntityManifestGrid";
import { RecipeDependencyGraph } from "~/app/_components/visualizations/recipe-dependency-graph";
import { Row, Stack } from "~/components/layout";
import { Page } from "~/components/page/Page";
import { Checkbox } from "~/components/ui/checkbox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { useTabParam } from "~/hooks/useTabParam";
import { useTRPC } from "~/trpc/react";

const searchSchema = z.object({
  // Active tab, deep-linkable. Default ("recipes") is omitted from the URL.
  tab: z.enum(["recipes", "schema"]).optional().catch(undefined),
  // Recipe-graph filters (migrated from the old /recipes/graph route).
  cookbookId: z.string().optional().catch(undefined),
  hide: z.boolean().optional().catch(true),
});

export const Route = createFileRoute("/_authenticated/entities")({
  validateSearch: searchSchema,
  component: EntitiesRoute,
  head: () => ({ meta: [{ title: "Entities | cubby" }] }),
});

function EntitiesRoute() {
  const { tab, cookbookId, hide } = Route.useSearch();
  const hideUnconnected = hide ?? true;
  const navigate = useNavigate();
  const hideId = useId();
  const api = useTRPC();
  const { data: cookbooks } = useQuery(api.recipe.listCookbooks.queryOptions());

  const tabs = useTabParam(tab, "recipes", (next) =>
    navigate({ to: ".", search: (prev) => ({ ...prev, tab: next }) }),
  );

  return (
    <Page variant="list" title="Entities" compact decoration="none">
      <Tabs value={tabs.value} onValueChange={tabs.onValueChange}>
        <TabsList variant="line">
          <TabsTrigger value="recipes">Recipe graph</TabsTrigger>
          <TabsTrigger value="schema">Schema</TabsTrigger>
        </TabsList>
        <TabsContent value="recipes">
          <Stack gap="md">
            <p className="text-muted-foreground text-sm">
              Each arrow points from a recipe to the sub-recipe it uses as an
              ingredient. Click a node to open that recipe.
            </p>

            <Row align="center" wrap gap="md">
              <label className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground">Cookbook</span>
                <select
                  className="h-8 rounded-md border bg-background px-2 text-sm"
                  value={cookbookId ?? ""}
                  onChange={(e) =>
                    navigate({
                      to: ".",
                      search: (prev) => ({
                        ...prev,
                        cookbookId: e.target.value || undefined,
                      }),
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
              <Row align="center" gap="sm" className="text-sm">
                <Checkbox
                  id={hideId}
                  checked={hideUnconnected}
                  onCheckedChange={(checked) =>
                    navigate({
                      to: ".",
                      search: (prev) => ({ ...prev, hide: checked === true }),
                    })
                  }
                />
                <label htmlFor={hideId} className="text-muted-foreground">
                  Hide unconnected recipes
                </label>
              </Row>
            </Row>

            <RecipeDependencyGraph
              cookbookId={cookbookId ? unsafeCookbookId(cookbookId) : undefined}
              hideUnconnected={hideUnconnected}
            />
          </Stack>
        </TabsContent>
        <TabsContent value="schema">
          <EntityManifestGrid />
        </TabsContent>
      </Tabs>
    </Page>
  );
}
