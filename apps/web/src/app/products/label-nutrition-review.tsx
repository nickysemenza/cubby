import { imageShortcode } from "@cubby/schemas/identifiers";
import {
  productLabelNutrition,
  type ProductLabelNutrition,
} from "@cubby/schemas/nutrition";
import { TIER1_NUTRIENTS, isNutrientKey, type NutrientKey } from "@cubby/usda";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { EntityEditDialog } from "~/entity/editing/entity-edit-dialog";
import type { DetailRecordOf } from "~/entity/entity-detail/detail-record";
import { imageProcessing } from "~/integrations/tanstack-query/generated/image-processing.gen";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { Stack } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";
import { Description } from "~/ui/primitives/description";
import { Image } from "~/ui/primitives/image";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/ui/primitives/table";
import { ShortcodeProse } from "~/ui/shortcode-prose";

const labelValue = (nutrition: ProductLabelNutrition, key: NutrientKey) => {
  const measured = nutrition.nutrients[key];
  if (measured !== undefined) return measured;
  return nutrition.inferenceEvidence &&
    nutrition.inferredZeroNutrients?.includes(key)
    ? "0 (inferred)"
    : "Unknown";
};

/** Current cloud evidence is a proposal until the normal Product editor explicitly saves it. */
export function LabelNutritionReview({
  product,
  label,
}: {
  product: DetailRecordOf<"product">;
  label: DetailRecordOf<"product">["labelImages"][number];
}) {
  const [open, setOpen] = useState(false);
  const id = imageShortcode.parse(label.id);
  const status = useQuery({
    ...imageProcessing.status.queryOptions({ id }),
    refetchInterval: (query) =>
      Object.values(query.state.data?.status ?? {}).some((value) =>
        ["pending", "leased", "waiting_for_device"].includes(value ?? ""),
      )
        ? 15_000
        : false,
    refetchIntervalInBackground: false,
  });
  const analysis = status.data?.analyses.find((entry) => entry.preferred);
  const proposal = useMemo(() => {
    if (!analysis?.result.nutritionFacts) return null;
    return productLabelNutrition.parse({
      ...analysis.result.nutritionFacts,
      source: `Package label ${id} · analysis ${analysis.createdAt}`,
    });
  }, [analysis, id]);
  const current = product.labelNutrition;
  const original = label.representations?.original ?? label.url;
  if (status.error) return <ErrorDisplay error={status.error} />;
  if (!proposal || current?.source === proposal.source) return null;
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => setOpen(true)}
      >
        Review detected nutrition
      </Button>
      <EntityEditDialog<"product">
        open={open}
        onOpenChange={setOpen}
        request={{
          entity: "product",
          operation: "update",
          intent: "full",
          record: product,
          seed: { labelNutrition: proposal },
        }}
        evidence={
          <Stack gap="md">
            <Description>
              Review the printed values against the source photo. Saving
              replaces the package label nutrition on this Product.
            </Description>
            <a href={original} target="_blank" rel="noreferrer">
              <Image
                src={original}
                alt="Source nutrition panel"
                displayWidth={240}
                className="max-h-64 w-60 max-w-full object-contain"
              />
            </a>
            <Description>
              <ShortcodeProse>{proposal.source ?? ""}</ShortcodeProse>
            </Description>
            {current ? (
              <details>
                <summary>
                  Current nutrition · {current.servingGrams} g per serving
                </summary>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Nutrient</TableHead>
                      <TableHead>Current</TableHead>
                      <TableHead>Detected</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {[
                      ...new Set([
                        ...Object.keys(current.nutrients),
                        ...Object.keys(proposal.nutrients),
                        ...(current.inferredZeroNutrients ?? []),
                        ...(proposal.inferredZeroNutrients ?? []),
                      ]),
                    ]
                      .filter(isNutrientKey)
                      .map((key) => (
                        <TableRow key={key}>
                          <TableCell>
                            {TIER1_NUTRIENTS[key].displayName}
                          </TableCell>
                          <TableCell>{labelValue(current, key)}</TableCell>
                          <TableCell>
                            {labelValue(proposal, key)}{" "}
                            {TIER1_NUTRIENTS[key].unit.toLowerCase()}
                          </TableCell>
                        </TableRow>
                      ))}
                  </TableBody>
                </Table>
              </details>
            ) : (
              <Description>No nutrition currently on file.</Description>
            )}
          </Stack>
        }
      />
    </>
  );
}
