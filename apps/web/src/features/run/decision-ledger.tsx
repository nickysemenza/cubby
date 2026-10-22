import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import {
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import type { RunDecision } from "~/contracts/run-detail.contract";
import { formatCount } from "~/lib/number-format";
import { cn } from "~/lib/utils";
import { EmptyState } from "~/ui/feedback/empty-state";
import { SidePanel, SidePanelLayout } from "~/ui/overlays/side-panel";
import { Input } from "~/ui/primitives/input";
import { Kbd } from "~/ui/primitives/kbd";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/ui/primitives/table";

import { StatusPill } from "../job/job-status";
import type { DecisionPresenter } from "./decision-presenters";

const typing = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

/**
 * The Assessments one step published, by facet and search: J/K move the
 * current row, Enter opens its evidence, `/` searches, Esc closes. Phones get
 * stacked rows. The rows are the Run's bounded publication, read once.
 */
export function DecisionLedger({
  rows,
  total,
  presenter,
  facet,
  onFacet,
  caption,
}: {
  rows: readonly RunDecision[];
  total: number;
  presenter: DecisionPresenter;
  facet: string | null;
  onFacet: (facet: string | null) => void;
  caption?: string;
}) {
  const [search, setSearch] = useState("");
  const query = useDeferredValue(search.trim().toLowerCase());
  const [current, setCurrent] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const searchId = useId();
  const counts = useMemo(() => {
    const byFacet = new Map<string, number>();
    for (const row of rows) {
      const key = presenter.facetOf(row).key;
      byFacet.set(key, (byFacet.get(key) ?? 0) + 1);
    }
    return byFacet;
  }, [rows, presenter]);
  const shown = useMemo(
    () =>
      rows.filter(
        (row) =>
          (facet === null || presenter.facetOf(row).key === facet) &&
          (!query || presenter.searchText(row).toLowerCase().includes(query)),
      ),
    [rows, facet, query, presenter],
  );
  const open = shown.find((row) => row.id === openId) ?? null;
  const step = (direction: -1 | 1) => {
    const next = Math.min(shown.length - 1, Math.max(0, current + direction));
    setCurrent(next);
    if (openId) setOpenId(shown[next]?.id ?? null);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "Escape" && openId) {
        setOpenId(null);
        return;
      }
      if (typing(event.target)) return;
      if (event.key === "/") {
        event.preventDefault();
        searchRef.current?.focus();
      } else if (event.key === "j" || event.key === "k") {
        event.preventDefault();
        step(event.key === "j" ? 1 : -1);
      } else if (event.key === "Enter" && shown[current]) {
        setOpenId(shown[current]?.id ?? null);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  const facetDefs = presenter.facets.filter((def) => counts.has(def.key));
  const panel = open ? (
    <SidePanel
      label="Decision evidence"
      eyebrow={
        <StatusPill tone={presenter.facetOf(open).tone}>
          {presenter.facetOf(open).label}
        </StatusPill>
      }
      title={presenter.title(open)}
      onClose={() => setOpenId(null)}
      onPrev={() => step(-1)}
      onNext={() => step(1)}
    >
      <presenter.Evidence row={open} />
    </SidePanel>
  ) : null;

  return (
    <SidePanelLayout
      panel={panel}
      title="Decision evidence"
      onClose={() => setOpenId(null)}
    >
      <div className="grid gap-0" data-testid="decision-ledger">
        <div className="flex flex-wrap items-center gap-2 py-2">
          <fieldset className="flex flex-wrap gap-1">
            <legend className="sr-only">Decision facets</legend>
            {[
              { key: null, label: "All", tone: null, count: rows.length },
              ...facetDefs.map((def) => ({
                ...def,
                count: counts.get(def.key) ?? 0,
              })),
            ].map((def) => (
              <button
                key={def.key ?? "all"}
                type="button"
                aria-pressed={facet === def.key}
                onClick={() => {
                  onFacet(def.key);
                  setCurrent(0);
                }}
                className="inline-flex h-6.5 items-center gap-1.5 rounded-lg border border-border bg-background px-2 text-xs text-foreground hover:bg-muted aria-pressed:border-foreground/25 aria-pressed:bg-row-current aria-pressed:font-medium aria-pressed:text-foreground-strong max-md:h-9"
              >
                {def.tone ? (
                  <span
                    aria-hidden
                    className={cn(
                      "size-1.75 rounded-full",
                      def.tone === "info" && "bg-info",
                      def.tone === "positive" && "bg-positive",
                      def.tone === "warning" && "bg-warning",
                      def.tone === "destructive" && "bg-destructive",
                      def.tone === "neutral" && "bg-muted-foreground",
                    )}
                  />
                ) : null}
                {def.label}
                <span className="font-mono text-2xs text-muted-foreground">
                  {formatCount(def.count)}
                </span>
              </button>
            ))}
          </fieldset>
          <label htmlFor={searchId} className="sr-only">
            Search decisions
          </label>
          <div className="relative ml-auto flex items-center max-md:ml-0 max-md:w-full">
            <MagnifyingGlassIcon
              aria-hidden
              className="pointer-events-none absolute left-2 size-3.5 text-muted-foreground"
            />
            <Input
              id={searchId}
              ref={searchRef}
              type="search"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setCurrent(0);
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") event.currentTarget.blur();
              }}
              placeholder="Search account, amount, ID"
              className="h-7.5 w-65 pr-7 pl-7 max-md:h-11 max-md:w-full"
            />
            <Kbd className="absolute right-2 max-md:hidden">/</Kbd>
          </div>
        </div>
        {facet !== null || query ? (
          <div className="flex flex-wrap items-center gap-1.5 pb-1.5 text-xs text-muted-foreground">
            {facet !== null ? (
              <span className="inline-flex h-5 items-stretch overflow-hidden rounded-md border border-border text-2xs text-foreground">
                <span className="px-1.5 leading-5 text-muted-foreground">
                  Status
                </span>
                <span className="border-l border-border px-1.5 leading-5">
                  {presenter.facets.find((def) => def.key === facet)?.label ??
                    facet}
                </span>
                <button
                  type="button"
                  aria-label="Clear status filter"
                  className="border-l border-border px-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                  onClick={() => onFacet(null)}
                >
                  <XIcon aria-hidden className="size-3" />
                </button>
              </span>
            ) : null}
            {query ? <span>matching “{search.trim()}”</span> : null}
          </div>
        ) : null}
        {shown.length === 0 ? (
          <EmptyState
            size="inline"
            description={`Clear the facet or search to see all ${formatCount(rows.length)}.`}
          >
            No decisions match
          </EmptyState>
        ) : (
          <>
            <Table
              containerClassName="border-t border-border max-md:hidden"
              className="min-w-[51.25rem] table-auto text-sm"
              aria-label="Decisions"
            >
              <TableHeader>
                <TableRow>
                  <TableHead>Status</TableHead>
                  {presenter.columns.map((column) => (
                    <TableHead
                      key={column.id}
                      className={cn(column.align === "right" && "text-right")}
                    >
                      {column.header}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.map((row, index) => {
                  const def = presenter.facetOf(row);
                  return (
                    <TableRow
                      key={row.id}
                      aria-current={index === current || undefined}
                      data-open={row.id === openId || undefined}
                      onClick={() => {
                        setCurrent(index);
                        setOpenId(row.id);
                      }}
                      className="cursor-pointer aria-current:bg-row-current data-open:[&>td:first-child]:border-l-2 data-open:[&>td:first-child]:border-l-foreground-strong"
                    >
                      <TableCell>
                        <StatusPill tone={def.tone}>{def.label}</StatusPill>
                      </TableCell>
                      {presenter.columns.map((column) => (
                        <TableCell
                          key={column.id}
                          className={cn(
                            "whitespace-nowrap",
                            column.align === "right" && "text-right",
                            column.className,
                          )}
                        >
                          {column.cell(row)}
                        </TableCell>
                      ))}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            <ul
              className="hidden border-t border-border max-md:block"
              aria-label="Decisions"
            >
              {shown.map((row, index) => {
                const def = presenter.facetOf(row);
                const phone = presenter.phone(row);
                return (
                  <li key={row.id} className="border-b border-border">
                    <button
                      type="button"
                      className="grid min-h-14 w-full gap-1 px-1 py-2 text-left"
                      onClick={() => {
                        setCurrent(index);
                        setOpenId(row.id);
                      }}
                    >
                      <span className="flex items-center justify-between gap-2 text-sm">
                        <span className="min-w-0 truncate">{phone.title}</span>
                        <StatusPill tone={def.tone}>{def.label}</StatusPill>
                      </span>
                      <span className="truncate text-xs text-muted-foreground">
                        {phone.meta}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}
        <p className="flex flex-wrap justify-between gap-2 py-2 text-xs text-muted-foreground">
          <span>
            {formatCount(shown.length)} of {formatCount(total)} decisions
            {caption ? ` · ${caption}` : ""}
            {total > rows.length
              ? ` · newest ${formatCount(rows.length)} loaded`
              : ""}
          </span>
          <span className="flex items-center gap-1 max-md:hidden">
            <Kbd>J</Kbd>
            <Kbd>K</Kbd> move · <Kbd>Enter</Kbd> open evidence · <Kbd>Esc</Kbd>{" "}
            close
          </span>
        </p>
      </div>
    </SidePanelLayout>
  );
}
