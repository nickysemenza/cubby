import { entitySchema } from "@cubby/schemas/entity";
import { cookbookShortcode } from "@cubby/schemas/identifiers";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useId } from "react";
import { z } from "zod";

import { EntityIntegrityTab } from "~/app/_components/entities/EntityIntegrityTab";
import { EntityManifestGrid } from "~/app/_components/entities/EntityManifestGrid";
import { CookbookSelect } from "~/app/_components/recipe/cookbook-select";
import { RecipeDependencyGraph } from "~/app/_components/visualizations/recipe-dependency-graph";
import { Row, Stack } from "~/components/layout";
import { Page } from "~/components/page/Page";
import { Checkbox } from "~/components/ui/checkbox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { useTabParam } from "~/hooks/useTabParam";
import { pageTitle } from "~/lib/page-title";

const searchSchema = z.object({
  // Active tab, deep-linkable. Default ("schema") is omitted from the URL —
  // it preserves the pre-merge /entities content (and its zero-query cost);
  // the recipe graph is opt-in via ?tab=recipes (the recipes-list Graph button).
  tab: z.enum(["recipes", "schema", "integrity"]).optional().catch(undefined),
  // Recipe-graph filters (migrated from the old /recipes/graph route). Branded
  // at the route boundary so garbage ?cookbookId= values are rejected here.
  cookbookId: cookbookShortcode.optional().catch(undefined),
  hide: z.boolean().optional().catch(true),
  entity: entitySchema.optional().catch(undefined),
});

export const Route = createFileRoute("/_authenticated/entities")({
  validateSearch: searchSchema,
  component: EntitiesRoute,
  head: () => ({ meta: [{ title: pageTitle("Entities") }] }),
});

function EntitiesRoute() {
  const { tab, entity } = Route.useSearch();
  const navigate = useNavigate();

  const tabs = useTabParam(tab, "schema", (next) =>
    navigate({ to: ".", search: (prev) => ({ ...prev, tab: next }) }),
  );

  return (
    <Page variant="list" title="Entities" compact decoration="none">
      <Tabs value={tabs.value} onValueChange={tabs.onValueChange}>
        <TabsList variant="line">
          <TabsTrigger value="schema">Schema</TabsTrigger>
          <TabsTrigger value="integrity">Integrity</TabsTrigger>
          <TabsTrigger value="recipes">Recipe graph</TabsTrigger>
        </TabsList>
        <TabsContent value="schema">
          <EntityManifestGrid
            selected={entity ?? "product"}
            active={tabs.value === "schema"}
            onSelect={(selected) =>
              navigate({
                to: ".",
                search: (prev) => ({ ...prev, entity: selected }),
              })
            }
          />
        </TabsContent>
        {/* Same reasoning as the recipe graph below: the catalog query and the
            Problems audit it cross-references only fire once this tab opens. */}
        <TabsContent value="integrity">
          <EntityIntegrityTab />
        </TabsContent>
        {/* Filters + graph live inside the tab content so their queries
            (listCookbooks, getDependencyGraph) fire only when this tab opens. */}
        <TabsContent value="recipes">
          <RecipeGraphTab />
        </TabsContent>
      </Tabs>
    </Page>
  );
}

function RecipeGraphTab() {
  const { cookbookId: selectedCookbook, hide } = Route.useSearch();
  const hideUnconnected = hide ?? true;
  const navigate = useNavigate();
  const hideId = useId();

  return (
    <Stack gap="md">
      <p className="text-sm text-muted-foreground">
        Each arrow points from a recipe to the sub-recipe it uses as an
        ingredient. Click a node to open that recipe.
      </p>

      <Row align="center" wrap gap="md">
        <CookbookSelect
          value={selectedCookbook}
          onChange={(id) =>
            navigate({
              to: ".",
              search: (prev) => ({ ...prev, cookbookId: id }),
            })
          }
        />
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
        cookbookId={selectedCookbook}
        hideUnconnected={hideUnconnected}
      />
    </Stack>
  );
}
