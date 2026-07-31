import type { RecipeShortcode } from "@cubby/schemas/identifiers";
import type {
  RecipeCostingExplain,
  RowDiagnosticOut,
} from "@cubby/schemas/recipe-shared";
import { useQuery } from "@tanstack/react-query";
import { match } from "ts-pattern";
import { Row } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { StatusText } from "~/components/ui/status-text";
import { useTRPC } from "~/integrations/trpc/react";
import { formatCurrency } from "~/lib/utils";
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
  const api = useTRPC();
  const { data, error } = useQuery(
    api.recipe.explainCosting.queryOptions({ id: recipeId }),
  );

  if (error) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle>Costing Debug</CardTitle>
        </CardHeader>
        <CardContent className="text-destructive text-sm">
          explain failed: {error.message}
        </CardContent>
      </Card>
    );
  }
  if (!data) return null;

  const { persisted, computed, drift } = data as RecipeCostingExplain;
  // When the live compute is known-degraded (USDA misses), drift against it is
  // expected and meaningless — don't shout about it.
  const showDrift = computed.complete && (drift.cost || drift.calories);

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
              ? `${formatCurrency(persisted.totals.costTotal)} · ${Math.round(persisted.totals.caloriesTotal)} kcal`
              : "—"}
            {persisted.totalsComputedAt &&
              ` @ ${persisted.totalsComputedAt.toLocaleString()}`}
          </span>
          <span className={showDrift ? "font-medium" : ""}>
            live {formatCurrency(computed.totals.costTotal)} ·{" "}
            {Math.round(computed.totals.caloriesTotal)} kcal
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
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-muted-foreground">
              <tr>
                <th className="py-1 pr-2">Row</th>
                <th className="py-1 pr-2">Usage</th>
                <th className="py-1 pr-2">Cost</th>
                <th className="py-1 pr-2">Weight</th>
                <th className="py-1 pr-2">Nutrients</th>
              </tr>
            </thead>
            <tbody>
              {computed.diagnostics.map((d) => (
                <tr key={d.id} className="border-t align-top">
                  <td className="py-1 pr-2">
                    {d.name}
                    {d.sectionName && (
                      <span className="block text-2xs text-muted-foreground">
                        {d.sectionName}
                      </span>
                    )}
                  </td>
                  <td className="py-1 pr-2">
                    <Badge variant="outline">{d.usage}</Badge>
                    {!d.measured && (
                      <span className="block text-2xs text-muted-foreground">
                        unmeasured
                        {d.basisGrams != null &&
                          ` · basis ${Math.round(d.basisGrams)} g`}
                      </span>
                    )}
                  </td>
                  <td className="py-1 pr-2">
                    <span className="block text-2xs text-muted-foreground">
                      {sourceLabel(d.plan.cost)}
                    </span>
                    <MeasureCell diag={d.price} path={d.paths?.money} />
                  </td>
                  <td className="py-1 pr-2">
                    <span className="block text-2xs text-muted-foreground">
                      {sourceLabel(d.plan.weight)}
                    </span>
                    <MeasureCell diag={d.gram} path={d.paths?.weight} />
                  </td>
                  <td className="py-1 pr-2">
                    <span className="block text-2xs text-muted-foreground">
                      {sourceLabel(d.plan.nutrients)}
                    </span>
                    <MeasureCell diag={d.nutrient} path={d.paths?.calories} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
};
