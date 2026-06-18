import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useTableDensity } from "~/app/_components/data-table/useTableDensity";
import { BackfillButton } from "~/app/problems/components/problem-backfill-action";
import { EntityLayout } from "~/components/layouts/entity-layout";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { Switch } from "~/components/ui/switch";
import { getErrorMessage } from "~/lib/error-utils";
import {
  FLAG_KEYS,
  FLAGS,
  type FlagGroup,
  type FlagKey,
  isDevBuildOnlyFlag,
  useFlags,
} from "~/lib/flags";
import { queryKeys } from "~/lib/query-keys";
import type { TimingResponse } from "~/routes/api/debug/timing";

export const Route = createFileRoute("/_authenticated/settings")({
  component: SettingsPage,
  head: () => ({ meta: [{ title: "Settings | cubby" }] }),
});

const GROUPS: { group: FlagGroup; blurb: string }[] = [
  {
    group: "Developer",
    blurb: "Diagnostics and debug tooling. Safe to leave on; off by default.",
  },
  {
    group: "Experimental",
    blurb: "Unfinished features — may change or break.",
  },
];

function SettingsPage() {
  const { flags, setFlag, resetFlags } = useFlags();
  return (
    <EntityLayout title="Settings">
      <div className="max-w-2xl space-y-4 pb-16">
        {GROUPS.map(({ group, blurb }) => {
          const keys = FLAG_KEYS.filter(
            (k) =>
              FLAGS[k].group === group &&
              // Hide toggles whose target is build-stripped in prod — flipping
              // them there does nothing, so the row would be a dead control.
              (import.meta.env.DEV || !isDevBuildOnlyFlag(k)),
          );
          if (keys.length === 0) return null;
          return (
            <Card key={group}>
              <CardHeader>
                <CardTitle>{group}</CardTitle>
                <CardDescription>{blurb}</CardDescription>
              </CardHeader>
              <CardContent className="divide-y divide-border/60">
                {keys.map((key) => (
                  <FlagRow
                    key={key}
                    flagKey={key}
                    value={flags[key]}
                    onChange={(v) => setFlag(key, v)}
                  />
                ))}
              </CardContent>
            </Card>
          );
        })}

        <DiagnosticsCard />

        <MaintenanceCard />

        <AppearanceCard />

        <Button variant="outline" size="sm" onClick={resetFlags}>
          Reset developer flags
        </Button>
      </div>
    </EntityLayout>
  );
}

function FlagRow({
  flagKey,
  value,
  onChange,
}: {
  flagKey: FlagKey;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  const def = FLAGS[flagKey];
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div className="space-y-0.5">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm">{def.label}</span>
          <code className="font-mono text-2xs text-muted-foreground">
            {flagKey}
          </code>
        </div>
        <p className="text-muted-foreground text-xs">{def.description}</p>
      </div>
      <Switch checked={value} onCheckedChange={onChange} />
    </div>
  );
}

function DiagnosticsCard() {
  const { data, error, isFetching, refetch, dataUpdatedAt } =
    useQuery<TimingResponse>({
      queryKey: queryKeys.debug.timing,
      queryFn: async () => {
        const res = await fetch("/api/debug/timing");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<TimingResponse>;
      },
      staleTime: 60_000,
      refetchOnWindowFocus: false,
      retry: false,
    });

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <CardTitle>Diagnostics</CardTitle>
            <CardDescription>
              Latency of core infrastructure — database, USDA API, and UPC
              lookup.
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="xs"
            onClick={() => refetch()}
            disabled={isFetching}
          >
            {isFetching ? "Measuring…" : "Re-run"}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="divide-y divide-border/60">
        {error ? (
          <p className="py-3 text-destructive text-xs">
            Timing check failed: {getErrorMessage(error)}
          </p>
        ) : !data ? (
          <p className="py-3 text-muted-foreground text-xs">Measuring…</p>
        ) : (
          <>
            {data.results.map((result) => (
              <div
                key={result.label}
                className="flex items-start justify-between gap-4 py-2"
              >
                <div className="min-w-0 space-y-0.5">
                  <code className="block truncate font-mono text-muted-foreground text-xs">
                    {result.label}
                  </code>
                  {result.error && (
                    <p className="text-destructive text-xs">{result.error}</p>
                  )}
                </div>
                <span className="shrink-0 font-medium font-mono text-sm tabular-nums">
                  {result.durationMs} ms
                </span>
              </div>
            ))}
            <div className="flex items-center justify-between gap-4 py-2 text-muted-foreground text-xs">
              <span>
                Last run {new Date(dataUpdatedAt).toLocaleTimeString()}
              </span>
              <span className="font-mono tabular-nums">
                total {data.totalMs} ms
              </span>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** One labeled maintenance action: description on the left, run-button on the right. */
function MaintenanceRow({
  label,
  description,
  action,
}: {
  label: string;
  description: string;
  action: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div className="space-y-0.5">
        <span className="font-medium text-sm">{label}</span>
        <p className="text-muted-foreground text-xs">{description}</p>
      </div>
      <div className="shrink-0">{action}</div>
    </div>
  );
}

// Batch operations that also surface on the Problems page when something needs
// attention — here they run on demand regardless of state, via the same
// BackfillButton plumbing (toast + invalidate). Rarely needed; this is their
// always-available home.
function MaintenanceCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Maintenance</CardTitle>
        <CardDescription>
          Force-run batch operations on demand — independent of whether the
          Problems page currently flags them.
        </CardDescription>
      </CardHeader>
      <CardContent className="divide-y divide-border/60">
        <MaintenanceRow
          label="Recompute recipe totals"
          description="Rebuild every recipe's cost / calorie / macro rollup, even when not marked stale."
          action={
            <BackfillButton
              selectMutation={(api) => api.recipe.recomputeAll.mutationOptions}
              invalidateKeys={(api) => [api.recipe.list.queryKey()]}
              idleLabel="Recompute all"
              pendingLabel="Recomputing…"
              toastResult={(r) => ({
                tone: "success",
                message: `Recomputed ${r.processed} recipe${r.processed === 1 ? "" : "s"}.`,
              })}
            />
          }
        />
        <MaintenanceRow
          label="Re-parse recipe lines"
          description="Re-run the ingredient parser over imported lines (rawLine). Reverts manual structured edits — intended."
          action={
            <BackfillButton
              selectMutation={(api) =>
                api.problems.reparseStale.mutationOptions
              }
              invalidateKeys={(api) => [api.recipe.list.queryKey()]}
              idleLabel="Re-parse all"
              pendingLabel="Re-parsing…"
              toastResult={(r) => ({
                tone: r.updated > 0 ? "success" : "info",
                message:
                  r.updated > 0
                    ? `Re-parsed ${r.updated} line${r.updated === 1 ? "" : "s"} across ${r.recipesAffected} recipe${r.recipesAffected === 1 ? "" : "s"}.`
                    : "Nothing to re-parse.",
              })}
            />
          }
        />
        <MaintenanceRow
          label="Sync inventory valuations"
          description="Recompute the dollar value of every inventory entry from current product prices."
          action={
            <BackfillButton
              selectMutation={(api) =>
                api.inventory.backfillInventoryValuations.mutationOptions
              }
              invalidateKeys={(api) => [api.inventory.list.queryKey()]}
              idleLabel="Sync all"
              pendingLabel="Syncing…"
              toastResult={(r) => ({
                tone: r.updated > 0 ? "success" : "info",
                message:
                  r.updated > 0
                    ? `Synced ${r.updated} entr${r.updated === 1 ? "y" : "ies"}.`
                    : "All valuations already current.",
              })}
            />
          }
        />
        <MaintenanceRow
          label="Fetch UPC images"
          description="Pull product images from the UPC database for products missing one."
          action={
            <BackfillButton
              selectMutation={(api) =>
                api.product.backfillUPCImages.mutationOptions
              }
              invalidateKeys={(api) => [api.product.list.queryKey()]}
              idleLabel="Fetch images"
              pendingLabel="Fetching…"
              toastResult={(r) => ({
                tone: r.imported > 0 ? "success" : "info",
                message: `Imported ${r.imported} image${r.imported === 1 ? "" : "s"} · ${r.found} found, ${r.skipped} skipped.`,
              })}
            />
          }
        />
        <MaintenanceRow
          label="Fix product categories"
          description="Re-derive product categories from their linked USDA food."
          action={
            <BackfillButton
              selectMutation={(api) =>
                api.product.backfillFoodCategories.mutationOptions
              }
              invalidateKeys={(api) => [api.product.list.queryKey()]}
              idleLabel="Fix all"
              pendingLabel="Fixing…"
              toastResult={(r) => ({
                tone: r.updated > 0 ? "success" : "info",
                message:
                  r.updated > 0
                    ? `Fixed ${r.updated} categor${r.updated === 1 ? "y" : "ies"}.`
                    : "All categories already set.",
              })}
            />
          }
        />
        <MaintenanceRow
          label="Analyze location descriptions"
          description="Generate AI descriptions for locations that don't have one yet."
          action={
            <BackfillButton
              selectMutation={(api) =>
                api.ai.backfillLocationDescriptions.mutationOptions
              }
              invalidateKeys={(api) => [api.location.list.queryKey()]}
              idleLabel="Analyze all"
              pendingLabel="Analyzing…"
              toastResult={(r) => ({
                tone: r.analyzed > 0 ? "success" : "info",
                message: `Analyzed ${r.analyzed} of ${r.total} location${r.total === 1 ? "" : "s"}.`,
              })}
            />
          }
        />
      </CardContent>
    </Card>
  );
}

const DENSITIES = ["comfortable", "compact", "dense"] as const;

function AppearanceCard() {
  const { density, setDensity } = useTableDensity();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Appearance</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between gap-4 py-1">
          <div className="space-y-0.5">
            <span className="font-medium text-sm">Table density</span>
            <p className="text-muted-foreground text-xs">
              Row height in data tables.
            </p>
          </div>
          <div className="flex gap-1">
            {DENSITIES.map((d) => (
              <Button
                key={d}
                size="xs"
                variant={density === d ? "default" : "outline"}
                onClick={() => setDensity(d)}
                className="capitalize"
              >
                {d}
              </Button>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
