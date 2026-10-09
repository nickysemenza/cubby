import type { RecipeShortcode } from "@cubby/schemas/identifiers";
import type { RowDiagnosticOut } from "@cubby/schemas/recipe-shared";
import { useQuery } from "@tanstack/react-query";
import { match } from "ts-pattern";

import { recipe } from "~/integrations/tanstack-query/generated/recipe.gen";
import { formatInstant } from "~/lib/date-format";
import { formatEstimate } from "~/lib/nutrition-format";
import { formatCurrency } from "~/lib/utils";
import { Row } from "~/ui/layout";
import { Badge } from "~/ui/primitives/badge";
import { Card, CardContent, CardHeader, CardTitle } from "~/ui/primitives/card";
import { StatusText } from "~/ui/primitives/status-text";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/ui/primitives/table";

import { CopyJsonButton } from "./copy-debug-button";

/**
 * Debug-mode card explaining how this recipe's cost/calorie totals were
 * produced: persisted state vs a live compute (drift highlighted), per-row
 * usage classification + the consumption rule that fired, exact per-measure
 * error strings (the detail the table cells swallow into "—"), and the
 * unit-graph conversion path each measure traversed. Mounted only when the
 * navbar debug toggle is on — same convention as the Raw Details card — so the
 * explain query never fires in normal use.
 */

// Wrapping, top-aligned cells: measure cells stack a source line over the
// value/error string, which must wrap rather than widen the row.
const CELL_CLASS = "py-1 pr-2 pl-0 align-top whitespace-normal";

const sourceLabel = (s: RowDiagnosticOut["plan"]["cost"]): string =>
  match(s)
    .with({ kind: "own-full" }, () => "own amount")
    .with({ kind: "own-fraction" }, (s) => `own ×${s.fraction}`)
    .with(
      { kind: "basis-fraction" },
      (s) => `${Math.round(s.fraction * 100)}% of basis`,
    )
    .with({ kind: "flat-grams" }, (s) => `flat ${s.grams} g`)
    .with({ kind: "missing" }, () => "—")
    .exhaustive();

const pathLabel = (
  path: { from_unit: string; to_unit: string; factor: number }[] | null,
): string | null => {
  const first = path?.[0];
  if (!path || !first) return null;
  const fmt = (f: number) => Number.parseFloat(f.toPrecision(4)).toString();
  return [
    first.from_unit,
    ...path.map((s) => `×${fmt(s.factor)}→ ${s.to_unit}`),
  ].join(" ");
};

const MeasureCell: React.FC<{
  diag: RowDiagnosticOut["price"] | RowDiagnosticOut["nutrient"];
  path?: { from_unit: string; to_unit: string; factor: number }[] | null;
}> = ({ diag, path }) => {
  if (!diag.ok) {
    return (
      <StatusText tone="destructive" className="text-xs">
        {diag.error}
      </StatusText>
    );
  }
  const value =
    "value" in diag
      ? `${Number.parseFloat(diag.value.toPrecision(4))} ${diag.unit}`
      : `${diag.kcal != null ? Math.round(diag.kcal) : "·"} kcal (${diag.nutrientCount} codes)`;
  const route = path !== undefined ? pathLabel(path ?? null) : null;
  return (
    <span className="text-xs">
      {value}
      {route && (
        <span className="block font-mono text-2xs text-muted-foreground">
          {route}
        </span>
      )}
    </span>
  );
};

export const RecipeCostingDebugCard: React.FC<{
  recipeId: RecipeShortcode;
}> = ({ recipeId }) => {
  const { data, error } = useQuery(
    recipe.explainCosting.queryOptions({ id: recipeId }),
  );

  if (error) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle>Costing Debug</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-destructive">
          explain failed: {error.message}
        </CardContent>
      </Card>
    );
  }
  if (!data) return null;

  const { persisted, computed, drift } = data;
  // When the live compute is known-degraded (USDA misses), drift against it is
  // expected and meaningless — don't shout about it.
  const showDrift =
    computed.complete &&
    (drift.cost || Object.values(drift.nutrition).some(Boolean));

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between pb-2">
        <CardTitle>Costing Debug</CardTitle>
        <CopyJsonButton
          value={data}
          title="Copy the full explain payload"
          label="copy explain"
        />
      </CardHeader>
      <CardContent className="space-y-2">
        {/* Persistence panel: stored vs live, staleness, completeness. */}
        <Row wrap align="center" gap="sm" className="text-xs">
          <Badge variant={persisted.stale ? "destructive" : "secondary"}>
            {persisted.stale ? "stale" : "fresh"}
          </Badge>
          {!computed.complete && (
            <Badge variant="destructive">USDA incomplete</Badge>
          )}
          <span className="text-muted-foreground">
            persisted{" "}
            {persisted.totals
              ? `${formatEstimate(persisted.totals.cost, formatCurrency)} · ${formatEstimate(persisted.totals.nutrition.kcal, (value) => `${Math.round(value)} kcal`)}`
              : "—"}
            {persisted.totalsComputedAt &&
              ` @ ${formatInstant(persisted.totalsComputedAt, "dateTime")}`}
          </span>
          <span className={showDrift ? "font-medium" : ""}>
            live {formatEstimate(computed.totals.cost, formatCurrency)} ·{" "}
            {formatEstimate(
              computed.totals.nutrition.kcal,
              (value) => `${Math.round(value)} kcal`,
            )}
            {showDrift && (
              <Badge className="ml-1" variant="destructive">
                drift
              </Badge>
            )}
          </span>
        </Row>

        {computed.usdaMisses.length > 0 && (
          <StatusText as="div" tone="destructive" className="text-xs">
            USDA misses:{" "}
            {computed.usdaMisses
              .map(
                (m) => `${m.ingredientName} (${m.productName} fdc ${m.fdcId})`,
              )
              .join(", ")}
          </StatusText>
        )}

        {/* Per-row trace: usage, fired rule per measure, value-or-error + path. */}
        <Table className="table-auto">
          <TableHeader>
            <TableRow>
              <TableHead className="h-auto py-1 pr-2 pl-0">Row</TableHead>
              <TableHead className="h-auto py-1 pr-2 pl-0">Usage</TableHead>
              <TableHead className="h-auto py-1 pr-2 pl-0">Cost</TableHead>
              <TableHead className="h-auto py-1 pr-2 pl-0">Weight</TableHead>
              <TableHead className="h-auto py-1 pr-2 pl-0">Nutrients</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {computed.diagnostics.map((d) => (
              <TableRow key={d.id} className="align-top">
                <TableCell className={CELL_CLASS}>
                  {d.name}
                  {d.sectionName && (
                    <span className="block text-2xs text-muted-foreground">
                      {d.sectionName}
                    </span>
                  )}
                </TableCell>
                <TableCell className={CELL_CLASS}>
                  <Badge variant="outline">{d.usage}</Badge>
                  {!d.measured && (
                    <span className="block text-2xs text-muted-foreground">
                      unmeasured
                      {d.basisGrams != null &&
                        ` · basis ${Math.round(d.basisGrams)} g`}
                    </span>
                  )}
                </TableCell>
                <TableCell className={CELL_CLASS}>
                  <span className="block text-2xs text-muted-foreground">
                    {sourceLabel(d.plan.cost)}
                  </span>
                  <MeasureCell diag={d.price} path={d.paths?.money} />
                </TableCell>
                <TableCell className={CELL_CLASS}>
                  <span className="block text-2xs text-muted-foreground">
                    {sourceLabel(d.plan.weight)}
                  </span>
                  <MeasureCell diag={d.gram} path={d.paths?.weight} />
                </TableCell>
                <TableCell className={CELL_CLASS}>
                  <span className="block text-2xs text-muted-foreground">
                    {sourceLabel(d.plan.nutrients)}
                    {d.nutritionSource && ` · ${d.nutritionSource}`}
                  </span>
                  <MeasureCell diag={d.nutrient} path={d.paths?.calories} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
};
