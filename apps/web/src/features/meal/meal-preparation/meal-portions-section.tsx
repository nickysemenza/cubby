import type { ReportBlock } from "@cubby/schemas/entity-report";
import type { MealShortcode } from "@cubby/schemas/identifiers";
import { MEAL_PORTIONS_BLOCK_KEY } from "@cubby/schemas/meal";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { useQuery } from "@tanstack/react-query";

import { ReportBlocks } from "~/entity/entity-detail/report-slot";
import { entityReport } from "~/integrations/tanstack-query/generated/catalog.gen";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { Row, Stack } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";
import { Description } from "~/ui/primitives/description";
import { Skeleton } from "~/ui/primitives/skeleton";

type PortionsBlock = Extract<ReportBlock, { kind: "records" }> & {
  key: string;
};

/** The report's Portions blocks; its Recipes block is drawn by the web recipe rows, which edit scale in place. */
const isPortions = (block: ReportBlock): block is PortionsBlock =>
  block.kind === "records" &&
  (block.key?.startsWith(MEAL_PORTIONS_BLOCK_KEY) ?? false);

/** Each prepared recipe's portions from the server's `meal.composition` report, under the leftovers capture. */
export function MealPortionsSection({
  mealId,
  onAddPreparedPortion,
  onEditPreparation,
}: {
  mealId: MealShortcode;
  onAddPreparedPortion?: () => void;
  /** Opens a preparation's portion editor (leftovers have no recipe row of their own here). */
  onEditPreparation?: (mealRecipeId: string) => void;
}) {
  const query = useQuery(
    entityReport.get.queryOptions({ slot: "meal.composition", id: mealId }),
  );
  const blocks = (query.data?.blocks ?? []).filter(isPortions);

  return (
    <Stack gap="sm">
      <Row align="start" justify="between" gap="sm" wrap>
        <Description size="xs">
          Record cooked yields and assign portions in the unit you know. Each
          amount stays with the meal where it was served.
        </Description>
        {onAddPreparedPortion ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onAddPreparedPortion}
          >
            <PlusIcon className="size-4" />
            Add leftovers
          </Button>
        ) : null}
      </Row>
      {query.isPending ? (
        <Skeleton className="h-16 w-full" />
      ) : query.isError ? (
        <ErrorDisplay
          error={query.error}
          title="the portions"
          onRetry={() => void query.refetch()}
        />
      ) : blocks.length === 0 ? (
        <div className="rounded-md border border-dashed border-[var(--border)] px-3 py-4">
          <Stack gap="xs">
            <span className="text-sm font-medium">No recipe portions yet</span>
            <Description size="xs">
              Add a recipe or bring in leftovers, then record who had how many
              servings, grams, or another known amount.
            </Description>
          </Stack>
        </div>
      ) : (
        blocks.map((block) => (
          <Stack key={block.key} gap="xs">
            <ReportBlocks blocks={[block]} />
            {onEditPreparation ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="w-fit"
                onClick={() =>
                  onEditPreparation(
                    block.key.slice(MEAL_PORTIONS_BLOCK_KEY.length),
                  )
                }
              >
                Edit portions
              </Button>
            ) : null}
          </Stack>
        ))
      )}
    </Stack>
  );
}
