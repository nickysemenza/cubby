import { type Entity, entitySchema } from "@cubby/schemas/entity";
import { allEntities } from "@cubby/schemas/entity-manifest";
import { useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import { Picker } from "~/ui/combobox/picker";
import type { PickerOption } from "~/ui/combobox/picker-option";
import { Input } from "~/ui/primitives/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/ui/primitives/table";

import { overridesFor } from "./entity-schema-model";

const rows = allEntities.flatMap((entity) =>
  overridesFor(entity).map((comparison) => ({ entity, ...comparison })),
);

const gridCell =
  "h-7 max-w-0 border-r border-b border-border/70 bg-card px-2 truncate group-hover/row:bg-muted";
const gridHead =
  "sticky top-0 z-10 h-7 border-r border-b border-border bg-muted px-2 text-left text-2xs font-medium text-muted-foreground";

/** `invalid`: the manifest does not compile without the input. The generator
 * refuses an override that compiles to its default, so none is `unchanged`. */
const OUTCOME_LABEL = {
  invalid: "Required",
  changed: "Changes default",
} as const;

const ENTITY_OPTIONS: readonly PickerOption[] = [
  { value: "", label: "All entities" },
  ...allEntities.map((item) => ({ value: item, label: item })),
];

const OUTCOME_OPTIONS: readonly PickerOption[] = [
  { value: "", label: "All outcomes" },
  { value: "changed", label: OUTCOME_LABEL.changed },
  { value: "invalid", label: OUTCOME_LABEL.invalid },
];

/** `model.fields[name].labelOverride` → `model.fields[*].labelOverride`. */
const familyOf = (path: string) => path.replace(/\[[^\]]*\]/gu, "[*]");

const families = [
  ...rows
    .reduce(
      (counts, row) =>
        counts.set(
          familyOf(row.path),
          (counts.get(familyOf(row.path)) ?? 0) + 1,
        ),
      new Map<string, number>(),
    )
    .entries(),
].sort(([, left], [, right]) => right - left);

/** Every declaration override across the manifest, one row each. Values are
 * truncated to one line with the full text in the title; the entity panel
 * and schema page carry the unabridged comparison. */
export function EntityOverrideTable({
  onSelectEntity,
}: {
  onSelectEntity: (entity: Entity) => void;
}) {
  const [query, setQuery] = useState("");
  const [entity, setEntity] = useState<Entity | "">("");
  const [outcome, setOutcome] = useState<"" | keyof typeof OUTCOME_LABEL>("");
  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    return rows.filter(
      (row) =>
        (!entity || row.entity === entity) &&
        (!outcome || row.status === outcome) &&
        (!term ||
          [row.entity, row.path, row.declared, row.without, row.reason].some(
            (value) => value?.toLowerCase().includes(term),
          )),
    );
  }, [query, entity, outcome]);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label="Search entity, path, or value"
          placeholder="Search entity, path, or value"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="h-8 max-w-sm min-w-48 flex-1"
        />
        <Picker
          compact
          label="Entity"
          className="w-44"
          options={ENTITY_OPTIONS}
          value={entity}
          onValueChange={(value) =>
            setEntity(value ? entitySchema.parse(value) : "")
          }
        />
        <Picker
          mode="choose"
          compact
          label="Outcome"
          className="w-40"
          options={OUTCOME_OPTIONS}
          value={outcome}
          onValueChange={(value) =>
            setOutcome(value === "changed" || value === "invalid" ? value : "")
          }
        />
        <span className="font-mono text-2xs text-muted-foreground tabular-nums">
          {filtered.length} of {rows.length}
        </span>
      </div>
      <div className="flex flex-wrap gap-1" aria-label="Override types">
        {families.map(([family, count]) => {
          const name = family.slice(family.lastIndexOf(".") + 1);
          return (
            <button
              key={family}
              type="button"
              title={family}
              aria-pressed={query === name}
              onClick={() => setQuery(query === name ? "" : name)}
              className="inline-flex items-center gap-1 rounded-sm border border-border px-1.5 py-0.5 font-mono text-2xs hover:bg-muted aria-pressed:bg-[var(--row-selected)]"
            >
              {name}
              <span className="text-muted-foreground tabular-nums">
                {count}
              </span>
            </button>
          );
        })}
      </div>
      <Table
        containerClassName="max-h-[calc(100dvh-14rem)] overflow-auto border-t border-l border-border"
        aria-label="Declaration overrides"
        className="w-full min-w-[56rem] table-fixed border-separate border-spacing-0 text-xs"
      >
        <TableHeader>
          <TableRow>
            <TableHead className={cn(gridHead, "w-[9rem]")}>Entity</TableHead>
            <TableHead className={cn(gridHead, "w-[24%]")}>
              Override path
            </TableHead>
            <TableHead className={gridHead}>Declared</TableHead>
            <TableHead className={gridHead}>Without override</TableHead>
            <TableHead className={cn(gridHead, "w-[7.5rem]")}>
              Outcome
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {filtered.map((row) => (
            <TableRow key={`${row.entity}.${row.path}`} className="group/row">
              <TableCell className={cn(gridCell, "p-0")}>
                <button
                  type="button"
                  onClick={() => onSelectEntity(row.entity)}
                  className="size-full truncate px-2 text-left font-mono hover:underline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                >
                  {row.entity}
                </button>
              </TableCell>
              <TableCell
                className={cn(gridCell, "font-mono text-2xs")}
                title={row.path}
              >
                {row.path}
              </TableCell>
              <TableCell
                className={cn(gridCell, "font-mono text-2xs")}
                title={row.declared}
              >
                {row.declared}
              </TableCell>
              <TableCell
                className={cn(
                  gridCell,
                  "font-mono text-2xs",
                  row.without === null && "font-sans text-muted-foreground",
                )}
                title={row.without ?? row.reason ?? undefined}
              >
                {row.without ?? row.reason ?? "No valid value"}
              </TableCell>
              <TableCell
                className={cn(
                  gridCell,
                  row.status === "invalid" && "text-muted-foreground",
                )}
                title={
                  row.status === "invalid"
                    ? "Removing this input fails compilation."
                    : undefined
                }
              >
                {OUTCOME_LABEL[row.status]}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
