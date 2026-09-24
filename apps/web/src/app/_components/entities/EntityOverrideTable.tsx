import { type Entity, entitySchema } from "@cubby/schemas/entity";
import { allEntities } from "@cubby/schemas/entity-manifest";
import { useMemo, useState } from "react";

import { Input } from "~/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { entityOverrideComparisons } from "~/entities/generated/entity-override-comparisons.gen";

const pageSize = 25;
const rows = allEntities.flatMap((entity) =>
  entityOverrideComparisons[entity].map((comparison) => ({
    entity,
    ...comparison,
  })),
);

function Value({ value }: { value: string | null }) {
  if (value === null)
    return <span className="text-muted-foreground">No valid value</span>;
  return (
    <code
      className="block max-w-full truncate font-mono text-2xs"
      title={value}
    >
      {value}
    </code>
  );
}

export function EntityOverrideTable() {
  const [query, setQuery] = useState("");
  const [entity, setEntity] = useState<Entity | "">("");
  const [outcome, setOutcome] = useState<"" | "changed" | "invalid">("");
  const [page, setPage] = useState(0);
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
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pageCount - 1);
  const visible = filtered.slice(
    currentPage * pageSize,
    (currentPage + 1) * pageSize,
  );

  return (
    <section className="space-y-3 border-t border-border/70 pt-4">
      <div>
        <h3 className="font-mono text-xs tracking-wider text-muted-foreground uppercase">
          Declaration overrides
        </h3>
        <p className="text-xs text-muted-foreground">
          {rows.length} explicit inputs. Each comparison compiles the manifest
          with that input removed.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <label
          htmlFor="entity-override-search"
          className="min-w-48 flex-1 text-xs"
        >
          Search entity, path, or value
          <Input
            id="entity-override-search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(0);
            }}
            className="mt-1 h-8"
          />
        </label>
        <label className="text-xs">
          Entity
          <select
            aria-label="Entity"
            value={entity}
            onChange={(event) => {
              setEntity(
                event.target.value === ""
                  ? ""
                  : entitySchema.parse(event.target.value),
              );
              setPage(0);
            }}
            className="mt-1 block h-8 rounded-sm border border-border bg-card px-2"
          >
            <option value="">All entities</option>
            {allEntities.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs">
          Outcome
          <select
            aria-label="Outcome"
            value={outcome}
            onChange={(event) => {
              const value = event.target.value;
              setOutcome(
                value === "changed" || value === "invalid" ? value : "",
              );
              setPage(0);
            }}
            className="mt-1 block h-8 rounded-sm border border-border bg-card px-2"
          >
            <option value="">All outcomes</option>
            <option value="changed">Changed</option>
            <option value="invalid">Invalid default</option>
          </select>
        </label>
      </div>
      <Table
        containerClassName="border-y"
        className="w-full min-w-[42rem] table-fixed text-xs"
      >
        <TableHeader>
          <TableRow>
            <TableHead className="w-[12%] px-2 py-1">Entity</TableHead>
            <TableHead className="w-[28%] px-2 py-1">Override path</TableHead>
            <TableHead className="w-[25%] px-2 py-1">Declared</TableHead>
            <TableHead className="w-[25%] px-2 py-1">
              Without override
            </TableHead>
            <TableHead className="w-[10%] px-2 py-1">Outcome</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {visible.map((row) => (
            <TableRow key={`${row.entity}.${row.path}`}>
              <TableCell className="px-2 py-1 font-mono">
                {row.entity}
              </TableCell>
              <TableCell className="px-2 py-1">
                <details>
                  <summary className="cursor-pointer font-mono text-2xs break-all focus-visible:outline-2 focus-visible:outline-ring">
                    {row.path}
                  </summary>
                  <div className="mt-2 space-y-2 text-2xs">
                    <div>
                      <strong>Declared</strong>
                      <pre className="overflow-auto break-all whitespace-pre-wrap">
                        {row.declared}
                      </pre>
                    </div>
                    <div>
                      <strong>Without override</strong>
                      <pre className="overflow-auto break-all whitespace-pre-wrap">
                        {row.without ?? "No valid value"}
                      </pre>
                    </div>
                    {row.reason && (
                      <div>
                        <strong>Reason</strong>
                        <p className="whitespace-pre-wrap">{row.reason}</p>
                      </div>
                    )}
                  </div>
                </details>
              </TableCell>
              <TableCell className="px-2 py-1">
                <Value value={row.declared} />
              </TableCell>
              <TableCell className="px-2 py-1">
                <Value value={row.without} />
              </TableCell>
              <TableCell className="px-2 py-1">
                {row.status === "invalid"
                  ? "Invalid"
                  : row.status === "changed"
                    ? "Changed"
                    : "Same"}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <div className="flex items-center gap-2 text-xs">
        <button
          type="button"
          disabled={currentPage === 0}
          onClick={() => setPage(currentPage - 1)}
          className="rounded-sm border px-2 py-1 disabled:opacity-40"
        >
          Previous
        </button>
        <span>
          {filtered.length} matches · page {currentPage + 1} of {pageCount}
        </span>
        <button
          type="button"
          disabled={currentPage + 1 >= pageCount}
          onClick={() => setPage(currentPage + 1)}
          className="rounded-sm border px-2 py-1 disabled:opacity-40"
        >
          Next
        </button>
      </div>
    </section>
  );
}
