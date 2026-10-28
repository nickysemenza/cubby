import type { CandidateEquivalence } from "@cubby/schemas/equivalences";
import { ArrowClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import {
  entityDisplayImageKey,
  useEntityDisplayImages,
} from "~/entity/entity-media/entity-display-images";
import RTable from "~/entity/table/table";
import { recipe } from "~/integrations/tanstack-query/domains/recipe";
import { cn } from "~/lib/utils";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
} from "~/ui/data-table/table-features";
import { attachCubbyColumnMeta } from "~/ui/data-table/table-meta";
import { useLocalTable } from "~/ui/data-table/use-local-table";
import { useHydrated } from "~/ui/hooks/use-hydrated";
import { Row, Stack } from "~/ui/layout";
import { SidePanel, useTableRowStep } from "~/ui/overlays/side-panel";
import { Button } from "~/ui/primitives/button";
import { Description } from "~/ui/primitives/description";
import { StatusText } from "~/ui/primitives/status-text";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/ui/primitives/tooltip";

import { equivalenceWorkbenchSearch } from "./equivalence-workbench-link";

// Format a ratio compactly: a few significant figures, no trailing noise.
const fmtRatio = (n: number): string =>
  n.toLocaleString(undefined, { maximumSignificantDigits: 3 });

// "1 cup ≈ 127 g". medianRatio is always unitB per 1 unitA.
const equivalenceLabel = (c: CandidateEquivalence): string =>
  `1 ${c.unitA} ≈ ${fmtRatio(c.medianRatio)} ${c.unitB}`;

// The agreement signal: how far the loosest observation strays from the tightest,
// as a ×factor. 1.0× = every recipe agreed exactly; higher = more disagreement.
const spreadLabel = (c: CandidateEquivalence): string => {
  const { min, max } = c.ratioSpread;
  if (min <= 0 || max === min) return "exact";
  return `${(max / min).toLocaleString(undefined, { maximumSignificantDigits: 2 })}×`;
};

/**
 * Report of candidate unit equivalences harvested from recipe lines that
 * carry a parenthetical secondary measure (e.g. "1 bunch kale (about 5 cups)" →
 * "1 bunch ≈ 5 cups" for kale). These are ingredient-scoped facts the conversion
 * engine can't derive on its own (cross-dimension: density / count / package
 * ratios). Runs automatically on load (with a Rescan button); rows are grouped by
 * ingredient. Each row opens the ingredient workbench with the proposed
 * conversion prefilled; the user still chooses the concrete Product whose
 * UnitMapping will store it and explicitly saves the write.
 */
export function EquivalencesReport() {
  const {
    data: harvest,
    isFetching: harvestFetching,
    error,
    refetch,
  } = useQuery({
    ...recipe.harvestEquivalences.queryOptions(),
  });
  // Hydration-stable: the server renders mid-scan with no candidates, while the
  // client's first render already has the streamed ones — so the scanning
  // notice, the button's `disabled`, and the summary all have to ignore the
  // data until hydration finishes. See useHydratedLoading.
  const hydrated = useHydrated();
  const data = hydrated ? harvest : undefined;
  const isFetching = !hydrated || harvestFetching;

  // Group candidates by ingredient (preserving the server's confidence order, so
  // the highest-signal ingredient leads and its rows stay contiguous).
  const groups = useMemo(() => {
    const byIngredient = new Map<string, CandidateEquivalence[]>();
    for (const c of data?.candidates ?? []) {
      const arr = byIngredient.get(c.ingredientId);
      if (arr) arr.push(c);
      else byIngredient.set(c.ingredientId, [c]);
    }
    return [...byIngredient.values()];
  }, [data]);
  const imageRefs = useMemo(
    () =>
      groups.flatMap((group) => [
        ...group.map((candidate) => ({
          entityKind: "ingredient" as const,
          entityId: candidate.ingredientId,
        })),
        ...group.flatMap((candidate) =>
          candidate.examples.map((example) => ({
            entityKind: "recipe" as const,
            entityId: example.recipeId,
          })),
        ),
      ]),
    [groups],
  );
  const displayImages = useEntityDisplayImages(imageRefs);

  return (
    <Stack>
      <Row align="center" gap="sm">
        <Button
          variant="outline"
          onClick={() => refetch()}
          disabled={isFetching}
        >
          <ArrowClockwiseIcon
            className={cn("size-4", isFetching && "animate-spin")}
          />
          {isFetching ? "Scanning…" : "Rescan"}
        </Button>
        {data &&
          (() => {
            const flagged = data.candidates.filter(
              (c) => c.existingRatio != null,
            ).length;
            const novel = data.candidates.length - flagged;
            return (
              <Description as="span">
                {novel} novel
                {flagged > 0 && ` · ${flagged} flagged (differ from existing)`}
                {data.hiddenCovered > 0 &&
                  ` · ${data.hiddenCovered} hidden (already convertible)`}
              </Description>
            );
          })()}
      </Row>

      {error && (
        <StatusText as="p" tone="destructive" className="text-sm">
          Scan failed: {error.message}
        </StatusText>
      )}

      {isFetching && !data && <Description>Scanning recipes…</Description>}

      {data && data.candidates.length === 0 && !isFetching && (
        <Description>
          No novel equivalences found — every harvested pair is either a
          same-dimension conversion or already covered by an existing mapping.
        </Description>
      )}

      {data && data.candidates.length > 0 && (
        <EquivalenceRows
          candidates={groups.flat()}
          displayImages={displayImages}
        />
      )}
    </Stack>
  );
}

const equivalenceHelper = createCubbyColumnHelper<CandidateEquivalence>();
const candidateId = (c: CandidateEquivalence) =>
  JSON.stringify([c.ingredientId, c.unitA, c.unitB]);
const candidateSearch = {
  text: (c: CandidateEquivalence) =>
    [
      c.ingredientName,
      equivalenceLabel(c),
      ...c.examples.map((ex) => `${ex.recipeName} ${ex.rawLine ?? ""}`),
    ].join(" "),
  placeholder: "Search ingredients, units, or examples",
};
type DisplayImages = ReturnType<typeof useEntityDisplayImages>;
function ReviewLink({ candidate: c }: { candidate: CandidateEquivalence }) {
  return (
    <Button
      variant="outline"
      size="sm"
      render={
        <Link
          to="/ingredients/workbench"
          search={equivalenceWorkbenchSearch(c)}
        />
      }
    >
      {c.existingRatio == null ? "Review" : "Resolve conflict"}
    </Button>
  );
}
function EquivalenceEvidence({
  candidate: c,
  displayImages,
  onClose,
}: {
  candidate: CandidateEquivalence;
  displayImages: DisplayImages;
  onClose: () => void;
}) {
  const step = useTableRowStep();
  return (
    <SidePanel
      label="Equivalence evidence"
      title={c.ingredientName}
      onClose={onClose}
      onPrev={() => step(-1)}
      onNext={() => step(1)}
      actions={<ReviewLink candidate={c} />}
    >
      <Stack className="p-3">
        <p>
          {equivalenceLabel(c)} · {c.occurrences} observations ·{" "}
          {spreadLabel(c)} spread
        </p>
        {c.existingRatio != null ? (
          <p>
            Existing mapping converts 1 {c.unitA} ≈ {fmtRatio(c.existingRatio)}{" "}
            {c.unitB}, but recipes suggest {fmtRatio(c.medianRatio)} {c.unitB}.
          </p>
        ) : null}
        <h3 className="text-sm font-medium">Recipe evidence</h3>
        <Stack as="ul" gap="sm">
          {c.examples.map((ex) => (
            <li key={`${ex.recipeId}-${ex.rawLine ?? ex.recipeName}`}>
              <EntityRefLink
                displayImage={
                  displayImages[
                    entityDisplayImageKey({
                      entityKind: "recipe",
                      entityId: ex.recipeId,
                    })
                  ] ?? null
                }
                entity="recipe"
                data={{ id: ex.recipeId, name: ex.recipeName }}
              />
              {ex.rawLine ? (
                <p className="text-xs text-muted-foreground">{ex.rawLine}</p>
              ) : null}
            </li>
          ))}
        </Stack>
      </Stack>
    </SidePanel>
  );
}
function EquivalenceRows({
  candidates,
  displayImages,
}: {
  candidates: CandidateEquivalence[];
  displayImages: DisplayImages;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const columns = useMemo(
    () =>
      createCubbyColumnCollection<CandidateEquivalence>((add) => {
        add(
          equivalenceHelper.accessor("ingredientName", {
            header: "Ingredient",
            size: 240,
            meta: attachCubbyColumnMeta<CandidateEquivalence>({
              mobile: { slot: "title", priority: 0 },
            }),
            cell: ({ row: { original: c } }) => (
              <EntityRefLink
                displayImage={
                  displayImages[
                    entityDisplayImageKey({
                      entityKind: "ingredient",
                      entityId: c.ingredientId,
                    })
                  ] ?? null
                }
                entity="ingredient"
                data={{ id: c.ingredientId, name: c.ingredientName }}
              />
            ),
          }),
        );
        add(
          equivalenceHelper.accessor(equivalenceLabel, {
            id: "equivalence",
            header: "Equivalence",
            size: 230,
            meta: attachCubbyColumnMeta<CandidateEquivalence>({
              mobile: { slot: "subtitle", priority: 0 },
            }),
            cell: ({ row: { original: c } }) => (
              <span className="inline-flex items-center gap-1">
                {equivalenceLabel(c)}
                {c.existingRatio != null ? (
                  <Tooltip>
                    <TooltipTrigger
                      render={<span className="text-warning" />}
                      tabIndex={0}
                      aria-label="Conflicts with existing mapping"
                    >
                      <WarningIcon className="size-3.5" />
                    </TooltipTrigger>
                    <TooltipContent>
                      Existing mapping: 1 {c.unitA} ≈{" "}
                      {fmtRatio(c.existingRatio)} {c.unitB}. Suggested:{" "}
                      {fmtRatio(c.medianRatio)} {c.unitB}.
                    </TooltipContent>
                  </Tooltip>
                ) : null}
              </span>
            ),
          }),
        );
        add(
          equivalenceHelper.accessor("occurrences", {
            header: "Seen",
            size: 80,
            meta: attachCubbyColumnMeta<CandidateEquivalence>({
              numeric: true,
              mobile: { slot: "meta", priority: 1 },
            }),
          }),
        );
        add(
          equivalenceHelper.accessor(
            (candidate) =>
              candidate.ratioSpread.min > 0
                ? candidate.ratioSpread.max / candidate.ratioSpread.min
                : 1,
            {
              id: "spread",
              header: "Spread",
              size: 90,
              cell: ({ row }) => spreadLabel(row.original),
              meta: attachCubbyColumnMeta<CandidateEquivalence>({
                mobile: { slot: "meta", priority: 2 },
              }),
            },
          ),
        );
        add(
          equivalenceHelper.accessor((c) => c.examples.length, {
            id: "examples",
            header: "Examples",
            size: 100,
            meta: attachCubbyColumnMeta<CandidateEquivalence>({
              numeric: true,
              mobile: { slot: "meta", priority: 3 },
            }),
            cell: ({ row }) => (
              <button
                type="button"
                className="text-primary hover:underline"
                onClick={() => setSelected(row.id)}
              >
                {row.original.examples.length} examples
              </button>
            ),
          }),
        );
        add(
          equivalenceHelper.display({
            id: "actions",
            header: "Action",
            size: 140,
            meta: attachCubbyColumnMeta<CandidateEquivalence>({
              entityColumnRole: "action",
              mobile: { slot: "actions", priority: 0 },
            }),
            cell: ({ row }) => <ReviewLink candidate={row.original} />,
          }),
        );
      }),
    [displayImages],
  );
  const table = useLocalTable({
    rows: candidates,
    columns,
    getRowId: candidateId,
    search: candidateSearch,
  });
  const current = table
    .getFilteredRowModel()
    .rows.find((row) => row.id === selected)?.original;
  const close = () => setSelected(null);
  return (
    <RTable
      table={table}
      embedded
      ariaLabel="Ingredient equivalences"
      withoutImages="Candidates are computed cross-unit ratios rather than stored records."
      currentRowId={current ? candidateId(current) : undefined}
      onRowClick={(row) => setSelected(row.id)}
      disableMobileDetailsHref
      inspector={{
        content: current ? (
          <EquivalenceEvidence
            candidate={current}
            displayImages={displayImages}
            onClose={close}
          />
        ) : null,
        title: "Equivalence evidence",
        onClose: close,
      }}
    />
  );
}
