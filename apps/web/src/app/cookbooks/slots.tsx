import type { CookbookShortcode } from "@cubby/schemas/identifiers";
import { ArrowClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import type { DetailSlotComponent } from "~/app/_components/entity-detail/detail-slots";
import { useBulkStream } from "~/app/_components/hooks/useBulkStream";
import { IngredientUsagePanel } from "~/app/_components/ingredient/ingredient-usage-panel";
import { recipeStreams } from "~/app/recipes/recipe.functions";
import { Row, Stack } from "~/components/layout";
import { BulkProgressBar } from "~/components/ui/bulk-progress-bar";
import { Button } from "~/components/ui/button";
import { Description } from "~/components/ui/description";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { invalidateOperationTags } from "~/integrations/tanstack-query/operation-cache";

import { CookbookRunReportPanel } from "./cookbook-run-report";

/**
 * A book stored in the retired extraction format. Nothing reads it any
 * more: re-importing from source, the run report and sub-recipe links all
 * refuse it. The recipes already imported still work — only the source
 * behind them is unreadable — so this is a notice pointing at the one action
 * that fixes it, not an error.
 */
function ReextractNotice() {
  return (
    <Row
      align="center"
      gap="sm"
      className="border border-warning/40 bg-warning/5 p-2"
    >
      <WarningIcon className="size-4 shrink-0 text-warning" />
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

/**
 * What the book contains: its ingredient usage, and the stored extraction
 * tree behind a disclosure (mounted only when opened — the run report ships
 * the whole book tree with it). A retired-format book has no readable tree.
 */
export const CookbookContents: DetailSlotComponent<"cookbook"> = ({
  record: cookbook,
}) => {
  const [reportOpen, setReportOpen] = useState(false);
  return (
    <Stack gap="md">
      <IngredientUsagePanel cookbookId={cookbook.id} />
      {!cookbook.needsReextract && (
        <details onToggle={(event) => setReportOpen(event.currentTarget.open)}>
          <summary className="cursor-pointer py-2 text-sm font-medium">
            Extraction report
          </summary>
          {reportOpen && <CookbookRunReportPanel cookbookId={cookbook.id} />}
        </details>
      )}
    </Stack>
  );
};

/**
 * Re-derive recipes from the stored extraction (no AI) and selectively
 * import the ones the source holds that the book does not yet.
 */
export const CookbookImportProgress: DetailSlotComponent<"cookbook"> = ({
  record: cookbook,
}) => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const reprocess = useBulkStream<
    never,
    { reprocessed: number; importableExtras: string[] }
  >();
  const notImported = Math.max(
    cookbook.sourceRecipeCount - cookbook.recipeCount,
    0,
  );
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
          return `Reprocessed ${reprocessed} recipe${reprocessed === 1 ? "" : "s"} from ${cookbook.book}${extra}`;
        },
        onDone: () => {
          void invalidateOperationTags(queryClient, ripple.recipeList);
        },
      },
    );
  return (
    <Stack gap="sm">
      {cookbook.needsReextract && <ReextractNotice />}
      <Row gap="sm" wrap>
        {notImported > 0 && (
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              navigate({
                to: "/recipes/import",
                search: { from: cookbook.id },
              })
            }
            title="Selectively import recipes from this cookbook's source (no AI)"
          >
            <PlusIcon />
            Add from source ({notImported})
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          onClick={() => void runReprocess(cookbook.id)}
          disabled={reprocess.running}
          title="Re-derive recipes from the stored extraction (no AI)"
        >
          <ArrowClockwiseIcon
            className={reprocess.running ? "animate-spin" : ""}
          />
          Reprocess
        </Button>
      </Row>
      {reprocess.running && (
        <BulkProgressBar verb="Reprocessing" progress={reprocess.progress} />
      )}
      <Description size="xs">
        {cookbook.recipeCount} of {cookbook.sourceRecipeCount} source recipes
        imported.
      </Description>
    </Stack>
  );
};
