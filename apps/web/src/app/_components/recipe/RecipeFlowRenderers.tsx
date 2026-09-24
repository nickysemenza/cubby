import type { RecipeOut, SectionIngredientOut } from "@cubby/schemas/recipe";
import type {
  RecipeFlowOperation,
  RecipeFlowPlan,
  RecipeFlowSource,
} from "@cubby/schemas/recipe-flow";
import { ArrowRightIcon as ArrowRight } from "@phosphor-icons/react/dist/csr/ArrowRight";
import { GitMergeIcon as GitMerge } from "@phosphor-icons/react/dist/csr/GitMerge";
import { WarningIcon as AlertTriangle } from "@phosphor-icons/react/dist/csr/Warning";
import { Link } from "@tanstack/react-router";
import { useId, useMemo } from "react";

import { Badge } from "~/components/ui/badge";
import { Table, TableBody, TableCell, TableRow } from "~/components/ui/table";
import { cn } from "~/lib/utils";

import { dottedEntityLink, EntityPreviewLink } from "../EntityPreviewLink";
import {
  buildDisplayQuantities,
  IngredientModifier,
  IngredientQuantities,
} from "./IngredientQuantities";
import {
  buildRecipeFlowLayout,
  type RecipeFlowLayout,
} from "./recipe-flow-layout";

const NO_GRAMS = new Map<string, { text: string; estimated: boolean }>();

function usageMap(recipe: RecipeOut): Map<string, SectionIngredientOut> {
  return new Map(
    recipe.sections.flatMap((section) =>
      section.ingredients.map((usage) => [usage.id, usage] as const),
    ),
  );
}

export function FlowSourceContent({
  source,
  usages,
  readable = false,
}: {
  source: RecipeFlowSource;
  usages: Map<string, SectionIngredientOut>;
  readable?: boolean;
}) {
  if (source.kind === "unlisted") {
    return (
      <>
        <span className="flex min-w-0 items-center gap-1 font-medium text-warning-ink">
          <AlertTriangle className="size-3.5 shrink-0" />
          <span
            className={readable ? "break-words" : "truncate"}
            title={source.label}
          >
            {source.label}
          </span>
        </span>
        <Badge variant="warning">unlisted</Badge>
      </>
    );
  }

  const usage = usages.get(source.usageId);
  if (!usage) {
    return <span className="text-destructive">Missing ingredient usage</span>;
  }
  const name =
    usage.type === "ingredient" ? usage.ingredient.name : usage.recipe.name;
  const id =
    usage.type === "ingredient" ? usage.ingredient.id : usage.recipe.id;
  const quantities = buildDisplayQuantities(usage, NO_GRAMS);

  return (
    <>
      <span
        className={cn(
          "min-w-0 font-medium",
          readable ? "text-sm leading-relaxed" : "text-xs leading-tight",
        )}
      >
        {usage.type === "recipe" ? (
          <Link
            to="/recipes/$shortcode"
            params={{ shortcode: usage.recipe.id }}
            search={{ view: "flow" }}
            className={cn(
              dottedEntityLink,
              readable && "inline-flex min-h-11 items-center",
            )}
            title={`Open ${name} flow`}
          >
            {name}
          </Link>
        ) : (
          <EntityPreviewLink
            displayImage={null}
            entity="ingredient"
            id={id}
            className={cn(
              dottedEntityLink,
              readable && "min-h-11 items-center",
            )}
          >
            {name}
          </EntityPreviewLink>
        )}
        <IngredientModifier modifier={usage.modifier} />
        {source.role && (
          <span
            className={
              readable
                ? "block text-xs text-muted-foreground"
                : "block font-mono text-2xs tracking-wider text-slate uppercase"
            }
          >
            {source.role}
          </span>
        )}
      </span>
      <IngredientQuantities
        quantities={quantities}
        className={readable ? "text-sm" : "text-2xs"}
        emptyText="—"
      />
    </>
  );
}

function FlowOperationContent({
  operation,
  isOutput,
}: {
  operation: RecipeFlowOperation;
  isOutput: boolean;
}) {
  return (
    <>
      <span className="font-mono text-2xs tracking-wider text-slate uppercase">
        {operation.label}
      </span>
      {operation.outputLabel && (
        <span className="text-2xs text-muted-foreground">
          → {operation.outputLabel}
        </span>
      )}
      {operation.annotations.length > 0 && (
        <span className="flex flex-wrap justify-center gap-1">
          {operation.annotations.map((annotation) => (
            <Badge
              variant={annotation.kind === "cue" ? "outline" : "slate"}
              key={`${annotation.kind}:${annotation.text}`}
              className="font-sans tracking-normal normal-case"
            >
              {annotation.text}
            </Badge>
          ))}
        </span>
      )}
      {isOutput && <Badge variant="positive">output</Badge>}
    </>
  );
}

function operationRelations(
  plan: RecipeFlowPlan,
  selectedOperationId: string | null,
): Set<string> {
  if (!selectedOperationId) return new Set();
  const operations = new Map(
    plan.operations.map((operation) => [operation.id, operation]),
  );
  const outgoing = new Map<string, string[]>();
  for (const operation of plan.operations) {
    for (const input of operation.inputs) {
      const targets = outgoing.get(input.id) ?? [];
      targets.push(operation.id);
      outgoing.set(input.id, targets);
    }
  }
  const related = new Set<string>();
  const visitUpstream = (id: string) => {
    if (related.has(id)) return;
    related.add(id);
    const operation = operations.get(id);
    for (const input of operation?.inputs ?? []) visitUpstream(input.id);
  };
  const visitDownstream = (id: string) => {
    if (related.has(`downstream:${id}`)) return;
    related.add(`downstream:${id}`);
    related.add(id);
    for (const target of outgoing.get(id) ?? []) visitDownstream(target);
  };
  visitUpstream(selectedOperationId);
  visitDownstream(selectedOperationId);
  return related;
}

interface RendererProps {
  recipe: RecipeOut;
  plan: RecipeFlowPlan;
  selectedOperationId: string | null;
  onSelectOperation: (operationId: string) => void;
}

const SOURCE_WIDTH = 220;
const OPERATION_WIDTH = 154;
const COLUMN_GAP = 76;
const ROW_HEIGHT = 94;
const NODE_HEIGHT = 70;
const CANVAS_PADDING = 20;

export function RecipeFlowMap({
  recipe,
  plan,
  selectedOperationId,
  onSelectOperation,
}: RendererProps) {
  const arrowId = useId().replace(/:/g, "");
  const layout = useMemo(
    () => buildRecipeFlowLayout(recipe, plan),
    [recipe, plan],
  );
  const usages = useMemo(() => usageMap(recipe), [recipe]);
  const related = useMemo(
    () => operationRelations(plan, selectedOperationId),
    [plan, selectedOperationId],
  );
  const outputs = new Set(plan.outputOperationIds);
  const sourcePositions = new Map(
    layout.sources.map((source, row) => [
      source.id,
      {
        x: CANVAS_PADDING,
        y: CANVAS_PADDING + row * ROW_HEIGHT,
        width: SOURCE_WIDTH,
        height: NODE_HEIGHT,
      },
    ]),
  );
  const operationPositions = new Map(
    layout.operations.map((placement) => [
      placement.operation.id,
      {
        x:
          CANVAS_PADDING +
          SOURCE_WIDTH +
          COLUMN_GAP +
          (placement.column - 1) * (OPERATION_WIDTH + COLUMN_GAP),
        y: CANVAS_PADDING + placement.rowCenter * ROW_HEIGHT,
        width: OPERATION_WIDTH,
        height: NODE_HEIGHT,
      },
    ]),
  );
  const positions = new Map([...sourcePositions, ...operationPositions]);
  const width =
    CANVAS_PADDING * 2 +
    SOURCE_WIDTH +
    Math.max(0, layout.columnCount - 1) * (OPERATION_WIDTH + COLUMN_GAP);
  const height = Math.max(
    240,
    CANVAS_PADDING * 2 + Math.max(1, layout.sources.length) * ROW_HEIGHT,
  );

  return (
    <div className="overflow-x-auto border border-[var(--border)] bg-card">
      <div className="relative" style={{ width: Math.max(width, 720), height }}>
        <svg
          aria-hidden="true"
          className="absolute inset-0"
          width={Math.max(width, 720)}
          height={height}
        >
          <defs>
            <marker
              id={arrowId}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="5"
              markerHeight="5"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--muted-foreground)" />
            </marker>
          </defs>
          {plan.operations.flatMap((operation) => {
            const target = positions.get(operation.id);
            if (!target) return [];
            return operation.inputs.flatMap((input) => {
              const source = positions.get(input.id);
              if (!source) return [];
              const x1 = source.x + source.width;
              const y1 = source.y + source.height / 2;
              const x2 = target.x;
              const y2 = target.y + target.height / 2;
              const bend = Math.max(28, (x2 - x1) / 2);
              const highlighted =
                selectedOperationId == null ||
                (related.has(input.id) && related.has(operation.id));
              return [
                <path
                  key={`${input.kind}:${input.id}->${operation.id}`}
                  d={`M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`}
                  fill="none"
                  stroke={
                    highlighted ? "var(--primary)" : "var(--muted-foreground)"
                  }
                  strokeOpacity={highlighted ? 0.75 : 0.2}
                  strokeWidth={highlighted ? 1.5 : 1}
                  markerEnd={`url(#${arrowId})`}
                />,
              ];
            });
          })}
        </svg>

        {layout.sources.map((source) => {
          const position = sourcePositions.get(source.id);
          if (!position) return null;
          const dimmed = selectedOperationId != null && !related.has(source.id);
          return (
            <div
              key={source.id}
              className={cn(
                "absolute grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 border border-[var(--border)] bg-background px-2 py-1 transition-opacity",
                source.kind === "unlisted" && "border-warning",
                dimmed && "opacity-40",
              )}
              style={position}
            >
              <FlowSourceContent source={source} usages={usages} />
            </div>
          );
        })}

        {layout.operations.map(({ operation }) => {
          const position = operationPositions.get(operation.id);
          if (!position) return null;
          const selected = selectedOperationId === operation.id;
          const dimmed =
            selectedOperationId != null && !related.has(operation.id);
          return (
            <button
              type="button"
              key={operation.id}
              onClick={() => onSelectOperation(operation.id)}
              aria-pressed={selected}
              className={cn(
                "absolute flex flex-col items-center justify-center gap-1 border bg-muted px-2 py-1 text-center transition-all hover:border-primary",
                outputs.has(operation.id)
                  ? "border-positive"
                  : "border-[var(--border)]",
                selected && "border-primary ring-2 ring-primary/20",
                dimmed && "opacity-40",
              )}
              style={position}
            >
              <FlowOperationContent
                operation={operation}
                isOutput={outputs.has(operation.id)}
              />
            </button>
          );
        })}
      </div>
    </div>
  );
}

function placementCoveringRow(
  layout: RecipeFlowLayout,
  column: number,
  row: number,
) {
  return layout.operations.find(
    (placement) =>
      placement.column === column &&
      placement.rowStart <= row &&
      row <= placement.rowEnd,
  );
}

export function RecipeFlowTable({
  recipe,
  plan,
  selectedOperationId,
  onSelectOperation,
}: RendererProps) {
  const layout = useMemo(
    () => buildRecipeFlowLayout(recipe, plan),
    [recipe, plan],
  );
  const usages = useMemo(() => usageMap(recipe), [recipe]);
  const related = useMemo(
    () => operationRelations(plan, selectedOperationId),
    [plan, selectedOperationId],
  );
  const outputs = new Set(plan.outputOperationIds);

  return (
    <Table
      className="table-auto border-collapse"
      containerClassName="border border-[var(--border)]"
    >
      <TableBody>
        {layout.sources.map((source, row) => (
          <TableRow key={source.id} className="h-14 hover:bg-transparent">
            <TableCell
              className={cn(
                "min-w-56 border-r bg-card whitespace-normal",
                selectedOperationId != null &&
                  !related.has(source.id) &&
                  "opacity-40",
              )}
            >
              <span className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
                <FlowSourceContent source={source} usages={usages} />
              </span>
            </TableCell>
            {Array.from(
              { length: Math.max(0, layout.columnCount - 1) },
              (_unused, offset) => offset + 1,
            ).map((column) => {
              const placement = placementCoveringRow(layout, column, row);
              if (!placement) {
                return (
                  <TableCell
                    key={column}
                    className="min-w-36 border-r bg-muted/20"
                  >
                    <ArrowRight className="mx-auto size-3.5 text-muted-foreground" />
                  </TableCell>
                );
              }
              if (placement.rowStart !== row) return null;
              const operation = placement.operation;
              const selected = selectedOperationId === operation.id;
              const dimmed =
                selectedOperationId != null && !related.has(operation.id);
              return (
                <TableCell
                  key={column}
                  rowSpan={placement.rowEnd - placement.rowStart + 1}
                  className={cn(
                    "min-w-40 border-r border-b bg-muted p-0 text-center align-middle whitespace-normal",
                    outputs.has(operation.id) && "bg-positive/10",
                    dimmed && "opacity-40",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => onSelectOperation(operation.id)}
                    aria-pressed={selected}
                    className={cn(
                      "flex min-h-14 w-full flex-col items-center justify-center gap-1 px-2 py-2 hover:bg-primary/10",
                      selected && "ring-2 ring-primary ring-inset",
                    )}
                  >
                    {operation.inputs.length > 1 && (
                      <GitMerge className="size-3.5 text-primary" />
                    )}
                    <FlowOperationContent
                      operation={operation}
                      isOutput={outputs.has(operation.id)}
                    />
                  </button>
                </TableCell>
              );
            })}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
