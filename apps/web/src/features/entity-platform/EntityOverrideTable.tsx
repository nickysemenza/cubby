import { type Entity, entitySchema } from "@cubby/schemas/entity";
import { allEntities } from "@cubby/schemas/entity-manifest";
import { useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import { Input } from "~/ui/primitives/input";
import { NativeSelect } from "~/ui/primitives/native-select";
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

const OUTCOME_LABEL = {
  invalid: "Invalid default",
  changed: "Changed",
  unchanged: "Unchanged",
} as const;

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
        <NativeSelect
          aria-label="Entity"
          value={entity}
          onChange={(event) =>
            setEntity(
              event.target.value === ""
                ? ""
                : entitySchema.parse(event.target.value),
            )
          }
        >
          <option value="">All entities</option>
          {allEntities.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect
          aria-label="Outcome"
          value={outcome}
          onChange={(event) => {
            const value = event.target.value;
            setOutcome(
              value === "changed" ||
                value === "invalid" ||
                value === "unchanged"
                ? value
                : "",
            );
          }}
        >
          <option value="">All outcomes</option>
          <option value="changed">Changed</option>
          <option value="invalid">Invalid default</option>
          <option value="unchanged">Unchanged</option>
        </NativeSelect>
        <span className="font-mono text-2xs text-muted-foreground tabular-nums">
          {filtered.length} of {rows.length}
        </span>
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
                  row.status === "invalid" && "text-destructive",
                )}
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
