import { entitySchema } from "@cubby/schemas/entity";
import {
  cookbookShortcode,
  projectShortcode,
  taskShortcode,
  recipeShortcode,
} from "@cubby/schemas/identifiers";
import { parseShortcode } from "@cubby/shared";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { lazy, Suspense, useMemo } from "react";
import { z } from "zod";

import { EntityIntegrityTab } from "~/app/_components/entities/EntityIntegrityTab";
import { EntityManifestGrid } from "~/app/_components/entities/EntityManifestGrid";
import { CookbookSelect } from "~/app/_components/recipe/cookbook-select";
import { EntityGraphPicker } from "~/app/_components/relationships/entity-graph-picker";
import { EntityRelations } from "~/app/_components/relationships/entity-relations";
import type { GraphFilters } from "~/app/_components/visualizations/dependency-graph-model";
const RecipeDependencyGraph = lazy(() =>
  import("~/app/_components/visualizations/recipe-dependency-graph").then(
    (module) => ({ default: module.RecipeDependencyGraph }),
  ),
);
const WorkDependencyGraph = lazy(() =>
  import("~/app/_components/visualizations/work-dependency-graph").then(
    (module) => ({ default: module.WorkDependencyGraph }),
  ),
);
import { Stack } from "~/components/layout";
import { Page } from "~/components/page/Page";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { useTabParam } from "~/hooks/useTabParam";
import { pageTitle } from "~/lib/page-title";

const tabSchema = z.enum(["recipes", "work", "schema", "integrity", "explore"]);
const graphRefSearchSchema = z.string().refine((value) => {
  const separator = value.indexOf(":");
  if (separator < 1) return false;
  const entity = entitySchema.safeParse(value.slice(0, separator));
  const shortcode = parseShortcode(value.slice(separator + 1));
  return entity.success && shortcode?.type === entity.data;
});
const searchSchema = z.object({
  // Active tab, deep-linkable. Default ("schema") is omitted from the URL —
  // it preserves the pre-merge /entities content (and its zero-query cost);
  // the recipe graph is opt-in via ?tab=recipes (the recipes-list Graph button).
  tab: tabSchema.optional().catch(undefined),
  // Recipe-graph filters (migrated from the old /recipes/graph route). Branded
  // at the route boundary so garbage ?cookbookId= values are rejected here.
  cookbookId: cookbookShortcode.optional().catch(undefined),
  hide: z.boolean().optional().catch(true),
  projectId: projectShortcode.optional().catch(undefined),
  focus: z
    .union([projectShortcode, taskShortcode, recipeShortcode])
    .optional()
    .catch(undefined),
  direction: z
    .enum(["all", "upstream", "downstream"])
    .optional()
    .catch(undefined),
  workKind: z.enum(["all", "project", "task"]).optional().catch(undefined),
  graphLocation: z.string().optional().catch(undefined),
  groupByLocation: z.boolean().optional().catch(undefined),
  grouped: z.boolean().optional().catch(undefined),
  completed: z.boolean().optional().catch(undefined),
  q: z.string().optional().catch(undefined),
  reduce: z.boolean().optional().catch(undefined),
  entity: entitySchema.optional().catch(undefined),
  root: z.string().optional().catch(undefined),
  view: z.enum(["list", "graph"]).optional().catch(undefined),
  layout: z.enum(["neighborhood", "flow"]).optional().catch(undefined),
  graphEntity: entitySchema.optional().catch(undefined),
  relationship: z.string().optional().catch(undefined),
  selected: graphRefSearchSchema.optional().catch(undefined),
  trail: z.array(graphRefSearchSchema).max(32).optional().catch(undefined),
  cursor: z.number().int().nonnegative().optional().catch(undefined),
  collapsed: z.array(z.string()).optional().catch(undefined),
  destination: graphRefSearchSchema.optional().catch(undefined),
  depth: z
    .union([z.literal(1), z.literal(2), z.literal(3)])
    .optional()
    .catch(undefined),
});

export const Route = createFileRoute("/_authenticated/entities")({
  validateSearch: searchSchema,
  beforeLoad: ({ search }) => {
    if (search.tab === "explore")
      throw redirect({
        to: "/graph",
        search: {
          entity: search.entity,
          root: search.root,
          selected: search.selected,
          destination: search.destination,
        },
      });
  },
  component: EntitiesRoute,
  head: () => ({ meta: [{ title: pageTitle("Entities") }] }),
});

function EntitiesRoute() {
  const { tab, entity } = Route.useSearch();
  const navigate = useNavigate();

  const tabs = useTabParam(tab, "schema", tabSchema, (next) =>
    navigate({
      to: ".",
      search: (prev) => ({
        ...prev,
        tab: next,
        focus: undefined,
        q: undefined,
      }),
    }),
  );

  return (
    <Page variant="list" title="Entities" compact decoration="none">
      <Tabs value={tabs.value} onValueChange={tabs.onValueChange}>
        <TabsList
          variant="line"
          className="h-auto max-w-full flex-wrap justify-start gap-2 [&>[data-slot=tabs-trigger]]:flex-none"
        >
          <TabsTrigger value="explore">Explore records</TabsTrigger>
          <TabsTrigger value="schema">Schema</TabsTrigger>
          <TabsTrigger value="integrity">Integrity</TabsTrigger>
          <TabsTrigger value="work">Projects &amp; tasks</TabsTrigger>
          <TabsTrigger value="recipes">Recipe graph</TabsTrigger>
        </TabsList>
        <TabsContent value="explore">
          <CrossEntityTab />
        </TabsContent>
        <TabsContent value="schema">
          <EntityManifestGrid
            selected={entity ?? null}
            active={tabs.value === "schema"}
            onSelect={(selected) =>
              navigate({
                to: ".",
                search: (prev) => ({ ...prev, entity: selected ?? undefined }),
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
          <Suspense fallback={<p>Loading graph…</p>}>
            <GraphTab recipes />
          </Suspense>
        </TabsContent>
        <TabsContent value="work">
          <Suspense fallback={<p>Loading graph…</p>}>
            <GraphTab recipes={false} />
          </Suspense>
        </TabsContent>
      </Tabs>
    </Page>
  );
}

function GraphTab({ recipes }: { recipes: boolean }) {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const filters = useMemo<GraphFilters>(
    () => ({
      focus: search.focus,
      workKind: recipes ? "all" : (search.workKind ?? "all"),
      direction: search.direction ?? "all",
      grouped: search.grouped ?? true,
      location: recipes ? undefined : search.graphLocation,
      groupByLocation: !recipes && (search.groupByLocation ?? false),
      hideCompleted: search.completed ?? true,
      hideUnconnected: recipes && (search.hide ?? true),
      reduceEdges: search.reduce ?? false,
    }),
    [
      search.focus,
      search.workKind,
      search.direction,
      search.grouped,
      search.groupByLocation,
      search.graphLocation,
      search.completed,
      search.hide,
      search.reduce,
      recipes,
    ],
  );
  const onChange = (patch: Partial<GraphFilters>) => {
    const next = { ...filters, ...patch };
    const focus = z
      .union([projectShortcode, taskShortcode, recipeShortcode])
      .optional()
      .parse(next.focus);
    void navigate({
      to: ".",
      search: (previous) => ({
        ...previous,
        focus,
        direction: next.direction,
        grouped: next.grouped,
        graphLocation: recipes ? previous.graphLocation : next.location,
        groupByLocation: recipes
          ? previous.groupByLocation
          : next.groupByLocation,
        workKind: recipes ? previous.workKind : next.workKind,
        completed: recipes ? previous.completed : next.hideCompleted,
        hide: recipes ? next.hideUnconnected : previous.hide,
        reduce: next.reduceEdges,
      }),
    });
  };
  const onSearch = (q: string) => {
    void navigate({
      to: ".",
      replace: true,
      search: (previous) => ({ ...previous, q: q || undefined }),
    });
  };
  if (!recipes)
    return (
      <Stack gap="md">
        <p className="text-sm text-muted-foreground">
          Dependency arrows point from blockers to blocked work. Dotted
          hierarchy connectors show projects and subtasks. Click a record to
          open it.
        </p>
        <WorkDependencyGraph
          search={search.q ?? ""}
          onSearch={onSearch}
          projectId={search.projectId}
          filters={filters}
          onChange={onChange}
          onScopeChange={(projectId) => {
            void navigate({
              to: ".",
              search: (previous) => ({
                ...previous,
                projectId,
                focus: undefined,
              }),
            });
          }}
        />
      </Stack>
    );
  return (
    <Stack gap="md">
      <p className="text-sm text-muted-foreground">
        Each arrow means “uses”: it points from a recipe to the sub-recipe it
        uses as an ingredient. Click a record to open it.
      </p>
      <CookbookSelect
        value={search.cookbookId}
        onChange={(cookbookId) => {
          void navigate({
            to: ".",
            search: (previous) => ({
              ...previous,
              cookbookId,
              focus: undefined,
            }),
          });
        }}
      />
      <RecipeDependencyGraph
        search={search.q ?? ""}
        onSearch={onSearch}
        cookbookId={search.cookbookId}
        filters={filters}
        onChange={onChange}
      />
    </Stack>
  );
}

function CrossEntityTab() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  return (
    <Stack gap="md">
      <p className="text-sm text-muted-foreground">
        Follow connections across your household. Choose a starting record, then
        reveal each relationship branch as you need it.
      </p>
      <EntityGraphPicker
        onSelect={(root) =>
          void navigate({
            to: "/entities",
            search: {
              tab: "explore",
              entity: root.entity,
              root: root.id,
              view: "graph",
            },
          })
        }
      />
      {search.entity && search.root ? (
        <EntityRelations
          entity={search.entity}
          sourceId={search.root}
          state={{
            view: search.view ?? "graph",
            layout: search.layout,
            query: search.q,
            entityType: search.graphEntity,
            relationship: search.relationship,
            selected: search.selected,
            trail: search.trail,
            cursor: search.cursor,
            collapsed: search.collapsed,
            destination: search.destination,
            depth: search.depth,
          }}
          onStateChange={(state) =>
            void navigate({
              to: "/entities",
              replace: true,
              search: () => ({
                ...search,
                view: state.view,
                layout: state.layout,
                q: state.query,
                graphEntity: state.entityType,
                relationship: state.relationship,
                selected: state.selected,
                trail: state.trail,
                cursor: state.cursor,
                collapsed: state.collapsed,
                destination: state.destination,
                depth: state.depth,
              }),
            })
          }
        />
      ) : (
        <p className="text-sm text-muted-foreground">
          Start with a cookbook, recipe, product, project, or any searchable
          record.
        </p>
      )}
    </Stack>
  );
}
