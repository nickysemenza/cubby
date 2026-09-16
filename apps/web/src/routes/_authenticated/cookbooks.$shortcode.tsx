import type { CookbookShortcode } from "@cubby/schemas/identifiers";
import type { CookbookSummary } from "@cubby/schemas/recipe";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import {
  createFileRoute,
  Link,
  notFound,
  useNavigate,
} from "@tanstack/react-router";
import { AlertTriangle, BookOpen, Link2, Plus, RefreshCw } from "lucide-react";
import { z } from "zod";

import {
  type DetailSection,
  DetailSections,
} from "~/app/_components/data-table/detail-page";
import { useBulkStream } from "~/app/_components/hooks/useBulkStream";
import { IngredientUsagePanel } from "~/app/_components/ingredient/ingredient-usage-panel";
import { notFoundPage } from "~/app/_components/routing/entity-routes";
import { CookbookPhysicalCopy } from "~/app/cookbooks/cookbook-physical-copy";
import { CookbookRunReportPanel } from "~/app/cookbooks/cookbook-run-report";
import { recipeStreams } from "~/app/recipes/recipe.functions";
import { RecipeList } from "~/app/recipes/recipelist";
import { Row } from "~/components/layout";
import type { DetailHeroStat } from "~/components/layouts/page-hero";
import { RouteErrorComponent } from "~/components/lazy-route-error";
import { Page } from "~/components/page/Page";
import { DetailPagePending } from "~/components/route-pending";
import { BulkProgressBar } from "~/components/ui/bulk-progress-bar";
import { Button } from "~/components/ui/button";
import { Description } from "~/components/ui/description";
import { Image } from "~/components/ui/image";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { cookbook as cookbookOperations } from "~/entities/cookbook.functions";
import { entitySearch } from "~/entities/generated/entity-search.gen";
import { useDetailTitle } from "~/hooks/useDocumentTitle";
import { useTabParam } from "~/hooks/useTabParam";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { invalidateOperationTags } from "~/integrations/tanstack-query/operation-cache";
import { shortcodeHead } from "~/lib/page-title";

const tabSchema = z.enum(["recipes", "ingredients", "report"]);
type CookbookTab = z.infer<typeof tabSchema>;

/**
 * The tabs this cookbook offers.
 *
 * A book stored in the retired format has no readable run report — the server
 * refuses to hand back its tree at all, and the only useful thing to say about
 * it is "re-extract from the EPUB" — so it is offered no report tab to open
 * onto an error.
 */
export const cookbookTabs = (cookbook: {
  needsReextract: boolean;
}): CookbookTab[] =>
  cookbook.needsReextract
    ? ["recipes", "ingredients"]
    : ["recipes", "ingredients", "report"];

const TAB_LABELS = {
  recipes: "Recipes",
  ingredients: "Ingredients",
  report: "Extraction",
} satisfies Record<CookbookTab, string>;
const searchSchema = z.object({
  // Active tab, deep-linkable. Default ("recipes") is omitted from the URL.
  tab: tabSchema.optional().catch(undefined),
  // Embedded RecipeList mirrors its filters and sort/page to the URL
  // (useTableState urlSync) — merge so this strict schema doesn't strip them.
  ...entitySearch.recipe.schema.shape,
});

const CookbookNotFound = notFoundPage("cookbook");

export interface CookbookDetailLoaderPort {
  load(shortcode: string): Promise<CookbookSummary | null>;
}

export async function loadCookbookDetail(
  shortcode: string,
  port: CookbookDetailLoaderPort,
): Promise<void> {
  const cookbook = await port.load(shortcode);
  if (!cookbook) throw notFound();
}

export const Route = createFileRoute("/_authenticated/cookbooks/$shortcode")({
  validateSearch: searchSchema,
  loader: ({ params, context }) =>
    loadCookbookDetail(params.shortcode, {
      load: (shortcode) =>
        context.queryClient.ensureQueryData(
          cookbookOperations.detail.queryOptions({ shortcode }),
        ),
    }),
  pendingComponent: DetailPagePending,
  errorComponent: RouteErrorComponent,
  notFoundComponent: CookbookNotFound,
  head: shortcodeHead,
  component: CookbookDetailPage,
});

function CookbookDetailPage() {
  const { shortcode } = Route.useParams();
  const { data: cookbook } = useSuspenseQuery(
    cookbookOperations.detail.queryOptions({ shortcode }),
  );
  // The loader establishes this before the route body mounts. Keep the guard
  // for a cache update that removes the current cookbook after navigation.
  if (!cookbook) throw notFound();

  return <CookbookDetailBody cookbook={cookbook} />;
}

function CookbookDetailBody({ cookbook }: { cookbook: CookbookSummary }) {
  const { shortcode } = Route.useParams();
  const { tab } = Route.useSearch();
  const navigate = useNavigate();

  const availableTabs = cookbookTabs(cookbook);
  // A deep link to a tab this book does not offer (a report on a retired-format
  // book) falls back to the recipes list rather than rendering an empty panel.
  const requestedTab =
    tab && availableTabs.includes(tab) ? tab : ("recipes" as const);
  const tabs = useTabParam(requestedTab, "recipes", tabSchema, (next) =>
    navigate({ to: ".", search: (prev) => ({ ...prev, tab: next }) }),
  );

  const cookbookId = cookbook.id;
  const name = cookbook.book;
  const recipeCount = cookbook.recipeCount;
  const coverUrl = cookbook.coverUrl;
  // How many recipes in the stored extraction aren't imported yet (gates the
  // "Add from source" entry into the selective re-importer).
  const notImported = Math.max(
    cookbook.sourceRecipeCount - cookbook.recipeCount,
    0,
  );

  useDetailTitle(shortcode, cookbook.book);

  // Reprocess streams progress server-side (one request) via useBulkStream. The
  // RefreshCw button drives it; a live bar shows beneath the hero while it runs.
  const queryClient = useQueryClient();
  const reprocess = useBulkStream<
    never,
    { reprocessed: number; importableExtras: string[] }
  >();
  // Takes the id rather than closing over it: this is declared above the
  // "not resolved yet" guard below, where `cookbookId` is still optional.
  const runReprocess = (id: CookbookShortcode) =>
    reprocess.start(
      (signal) =>
        recipeStreams.reprocessCookbook.open({ cookbookId: id }, { signal }),
      {
        successToast: ({ reprocessed, importableExtras }) => {
          const extra =
            importableExtras.length > 0
              ? ` (${importableExtras.length} more in the source not yet imported)`
              : "";
          return `Reprocessed ${reprocessed} recipe${reprocessed === 1 ? "" : "s"} from ${name}${extra}`;
        },
        onDone: () => {
          void invalidateOperationTags(queryClient, ripple.recipeList);
        },
      },
    );

  // Author + recipe count read as the spec-plate ledger stats; the cover plate
  // rides above the tabs (the spec-plate hero has no cover slot of its own).
  const heroStats: DetailHeroStat[] = [
    ...(cookbook.author.length > 0
      ? [{ label: "Author", value: cookbook.author.join(", ") }]
      : []),
    ...(recipeCount !== undefined
      ? [
          {
            label: "Recipes",
            value: `${recipeCount} ${recipeCount === 1 ? "recipe" : "recipes"}`,
          },
        ]
      : []),
  ];

  const sections: DetailSection[] = [
    {
      id: "physical-copy",
      title: "Physical copy",
      icon: Link2,
      placement: "supporting",
      content: (
        <CookbookPhysicalCopy
          cookbookId={cookbookId}
          cookbookName={name}
          product={cookbook.product ?? null}
        />
      ),
    },
    {
      id: "cookbook",
      title: "Recipes & ingredients",
      icon: BookOpen,
      placement: "full",
      surface: "plain",
      content: (
        <div className="space-y-2">
          {cookbook.needsReextract && <ReextractNotice />}
          {reprocess.running && (
            <BulkProgressBar
              verb="Reprocessing"
              progress={reprocess.progress}
            />
          )}
          <Tabs value={tabs.value} onValueChange={tabs.onValueChange}>
            <TabsList variant="line">
              {availableTabs.map((value) => (
                <TabsTrigger key={value} value={value}>
                  {TAB_LABELS[value]}
                </TabsTrigger>
              ))}
            </TabsList>
            <TabsContent value="recipes">
              {/* cookbookIdFilter pins this table to one cookbook via
                  extraFilters. Its Source control stays hidden because that
                  scope deliberately outranks an in-table cookbook filter. */}
              <RecipeList
                cookbookIdFilter={cookbookId}
                hiddenFilterColumns={["source"]}
              />
            </TabsContent>
            <TabsContent value="ingredients">
              <IngredientUsagePanel cookbookId={cookbookId} />
            </TabsContent>
            <TabsContent value="report">
              {/* Mounted only while selected: the run report ships the whole
                  stored book tree with it, which the other tabs never need. */}
              {tabs.value === "report" && (
                <CookbookRunReportPanel cookbookId={cookbookId} />
              )}
            </TabsContent>
          </Tabs>
        </div>
      ),
    },
  ];

  return (
    <Page
      variant="detail"
      title={name}
      entity="cookbook"
      rawData={cookbook}
      heroNo={cookbook.id}
      heroStats={heroStats}
      layout="full"
      heroMedia={
        coverUrl ? (
          <div className="flex justify-center border-y border-border bg-card p-3 md:rounded-md md:border">
            <Image
              src={coverUrl}
              alt={name}
              displayWidth={320}
              className="max-h-72 w-auto object-contain"
            />
          </div>
        ) : undefined
      }
      heroActions={{
        primary:
          notImported > 0 ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                navigate({
                  to: "/recipes/import",
                  search: { from: cookbookId },
                })
              }
              title="Selectively import recipes from this cookbook's source (no AI)"
            >
              <Plus className="mr-2 size-4" />
              Add from source ({notImported})
            </Button>
          ) : undefined,
        secondary: (
          <Row align="center" gap="sm">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void runReprocess(cookbookId)}
              disabled={reprocess.running}
              title="Re-derive recipes from the stored extraction (no AI)"
            >
              <RefreshCw
                className={`mr-2 size-4 ${reprocess.running ? "animate-spin" : ""}`}
              />
              Reprocess
            </Button>
          </Row>
        ),
      }}
    >
      <DetailSections sections={sections} rawData={cookbook} />
    </Page>
  );
}

/**
 * A book stored in the retired extraction format.
 *
 * Nothing reads it any more: the stored JSON predates the `cookbook` crate's
 * book tree, so re-importing from source, the run report, and sub-recipe links
 * all refuse it. The recipes already imported are untouched and still work —
 * only the source behind them is unreadable — so this is a notice, not an
 * error, and it points at the one action that fixes it.
 */
function ReextractNotice() {
  return (
    <Row
      align="center"
      gap="sm"
      className="border border-warning/40 bg-warning/5 p-2"
    >
      <AlertTriangle className="size-4 shrink-0 text-warning" />
      <Description as="span" size="xs" className="text-warning-ink">
        Extracted with a retired format — re-extract from the EPUB to restore
        the source, its run report, and sub-recipe links.
      </Description>
      <Link
        to="/recipes/import"
        className="text-xs font-medium text-primary hover:underline"
      >
        Go to import
      </Link>
    </Row>
  );
}
