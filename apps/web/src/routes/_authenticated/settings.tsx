import type { MaintenanceCounts } from "@cubby/schemas/problems";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useTableDensity } from "~/app/_components/data-table/useTableDensity";
import { BACKFILL } from "~/app/problems/components/backfill-registry";
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
import { useTRPC } from "~/trpc/react";

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

/** One labeled maintenance action: description left, dry-run count + run-button right. */
function MaintenanceRow({
  label,
  description,
  showCount = false,
  count,
  approximate = false,
  action,
}: {
  label: string;
  description: string;
  /** Whether this tool has an always-on affected count. */
  showCount?: boolean;
  /** The affected figure; undefined while the counts query loads. */
  count?: number;
  /**
   * Count is a candidate set the action only *attempts* (an external lookup/API
   * may not change every one) → render "up to N" instead of "N affected".
   */
  approximate?: boolean;
  action: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div className="space-y-0.5">
        <span className="font-medium text-sm">{label}</span>
        <p className="text-muted-foreground text-xs">{description}</p>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {showCount && (
          <span className="font-mono text-2xs text-muted-foreground tabular-nums">
            {count == null
              ? "—"
              : approximate
                ? `up to ${count}`
                : `${count} affected`}
          </span>
        )}
        {action}
      </div>
    </div>
  );
}

// Recompute's accurate "would change" needs a full compute+diff (~as costly as
// recomputing), so it's an on-demand dry run rather than an always-on count. The
// force-recompute button stays — it's the only path that catches logic-change
// drift the stale flag misses.
function RecomputeAction() {
  const trpc = useTRPC();
  const dryRun = useQuery({
    ...trpc.recipe.dryRunRecomputeTotals.queryOptions(),
    enabled: false,
  });
  return (
    <div className="flex items-center gap-3">
      {dryRun.data && (
        <span className="font-mono text-2xs text-muted-foreground tabular-nums">
          {dryRun.data.wouldChange} of {dryRun.data.total} would change
        </span>
      )}
      <Button
        variant="outline"
        size="sm"
        onClick={() => dryRun.refetch()}
        disabled={dryRun.isFetching}
      >
        {dryRun.isFetching ? "Checking…" : "Dry run"}
      </Button>
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
    </div>
  );
}

// Batch operations that also surface on the Problems page when something needs
// attention — here they run on demand regardless of state, via the same
// BackfillButton plumbing (toast + invalidate). Declared as data (each row's
// typed BackfillButton lives in `action`, mirroring the Problems registry's
// `headerAction`); the card just maps over them.
const MAINTENANCE_TOOLS: {
  label: string;
  description: string;
  // Always-on affected count; omitted for tools whose accurate count is
  // expensive (recompute uses an on-demand dry run instead).
  count?: (c: MaintenanceCounts) => number;
  // Count is a candidate set the action only attempts (external lookup/API may
  // not change every one) → shown as "up to N" rather than "N affected".
  approximate?: boolean;
  action: ReactNode;
}[] = [
  {
    label: "Recompute recipe totals",
    description:
      "Rebuild every recipe's cost / calorie / macro rollup, even when not marked stale.",
    action: <RecomputeAction />,
  },
  {
    label: "Re-parse recipe lines",
    description:
      "Re-run the ingredient parser over imported lines (rawLine). Reverts manual structured edits — intended.",
    count: (c) => c.staleIngredientParses,
    action: <BackfillButton {...BACKFILL.reparse} />,
  },
  {
    label: "Fetch UPC images",
    description:
      "Pull product images from the UPC database for products missing one.",
    count: (c) => c.productsWithNoImages,
    // A UPC lookup can return no image, so not every candidate gets one.
    approximate: true,
    action: <BackfillButton {...BACKFILL.fetchUpcImages} />,
  },
  {
    label: "Fix product categories",
    description: "Re-derive product categories from their linked USDA food.",
    count: (c) => c.productsWithWrongCategory,
    action: <BackfillButton {...BACKFILL.fixCategories} />,
  },
  {
    label: "Analyze location descriptions",
    description:
      "Generate AI descriptions for locations that don't have one yet.",
    count: (c) => c.locationsWithoutAiDescription,
    // An AI generation can fail, so not every candidate ends up described.
    approximate: true,
    action: <BackfillButton {...BACKFILL.analyzeDescriptions} />,
  },
];

function MaintenanceCard() {
  const trpc = useTRPC();
  // Dry-run "N affected" figures — one cheap DB/WASM query (no USDA/UPC network).
  const { data: counts } = useQuery(
    trpc.problems.getMaintenanceCounts.queryOptions(undefined, {
      staleTime: 30_000,
    }),
  );

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
        {MAINTENANCE_TOOLS.map((t) => (
          <MaintenanceRow
            key={t.label}
            label={t.label}
            description={t.description}
            showCount={!!t.count}
            count={t.count && counts ? t.count(counts) : undefined}
            approximate={t.approximate}
            action={t.action}
          />
        ))}
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
