import { format } from "date-fns";
import type { ReactNode } from "react";
import { z } from "zod";

import { HoverableTimestamp } from "~/app/_components/HoverableTimestamp";
import JsonRenderer from "~/app/_components/json-renderer";
import { EnumPill } from "~/components/ui/enum-pill";
import { NoneValue } from "~/components/ui/none-value";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "~/components/ui/popover";
import { parsePlainDate } from "~/lib/plain-date";

export type ScalarDisplayValue =
  | { kind: "empty"; raw: null | undefined }
  | { kind: "text"; raw: string; label: string }
  /** A declared enum value with its roster presentation; `raw` stays the
   * stored value for copy, sort, and filter seeds. */
  | {
      kind: "enum";
      raw: string;
      label: string;
      color: string;
      icon?: ReactNode;
      description?: string;
    }
  | { kind: "number"; raw: number }
  | { kind: "boolean"; raw: boolean }
  | { kind: "date"; raw: string }
  | { kind: "timestamp"; raw: string | Date }
  | { kind: "list"; raw: string[] }
  /** A structured value with no domain renderer; shown as readable JSON. */
  | { kind: "json"; raw: unknown };

/**
 * Splits a URL or slash path so a list cell can shrink its shared prefix and
 * keep the distinguishing tail. End-truncating a column of URLs or storage
 * keys from one host printed the same "https://media…." on every row.
 */
function splitPathLabel(label: string): { head: string; tail: string } | null {
  if (/\s/.test(label)) return null;
  let path = label;
  let host = "";
  if (/^https?:\/\//i.test(label)) {
    try {
      const url = new URL(label);
      host = url.host;
      path = url.pathname;
    } catch {
      return null;
    }
  }
  const segments = path.split("/").filter(Boolean);
  const tail = segments.at(-1);
  if (!tail || (segments.length < 2 && !host)) return null;
  const head = [host, ...segments.slice(0, -1)].filter(Boolean).join("/");
  return { head: `${head}/`, tail: safeDecode(tail) };
}

function safeDecode(segment: string) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function ListTextValue({ label }: { label: string }) {
  const parts = splitPathLabel(label);
  if (!parts) {
    return (
      <span className="block truncate" title={label}>
        {label}
      </span>
    );
  }
  return (
    <span className="flex min-w-0" title={label}>
      <span className="min-w-[1.5ch] shrink truncate text-muted-foreground">
        {parts.head}
      </span>
      <span className="min-w-0 [flex-shrink:0.001] truncate">{parts.tail}</span>
    </span>
  );
}

const structuredJson = z.json();
type StructuredJson = z.infer<typeof structuredJson>;

function structuredSummary(value: StructuredJson): string | null {
  if (Array.isArray(value))
    return value.length > 0
      ? `${value.length} ${value.length === 1 ? "item" : "items"}`
      : null;
  const object = z.record(z.string(), structuredJson).safeParse(value);
  if (object.success) {
    const count = Object.keys(object.data).length;
    return count > 0 ? `${count} ${count === 1 ? "field" : "fields"}` : null;
  }
  return value == null ? null : String(value);
}

function StructuredValue({
  value,
  surface,
}: {
  value: Extract<ScalarDisplayValue, { kind: "json" }>;
  surface: "list" | "detail" | "plain";
}) {
  const parsed = structuredJson.safeParse(value.raw);
  const summary = parsed.success
    ? structuredSummary(parsed.data)
    : "Structured value";
  if (summary === null) return <NoneValue />;
  if (surface === "detail")
    return (
      <details className="max-w-full min-w-0">
        <summary className="cursor-pointer text-primary">{summary}</summary>
        <div className="mt-2 max-h-80 max-w-full overflow-auto text-xs">
          <JsonRenderer input={value.raw} />
        </div>
      </details>
    );
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={`Show ${summary} details`}
            className="block max-w-full truncate text-left text-primary hover:underline"
            onClick={(event) => event.stopPropagation()}
          />
        }
      >
        {summary}
      </PopoverTrigger>
      <PopoverContent className="max-h-80 w-[min(32rem,80vw)] overflow-auto">
        <JsonRenderer input={value.raw} />
      </PopoverContent>
    </Popover>
  );
}

export function renderScalarValue(
  value: ScalarDisplayValue,
  surface: "list" | "detail" | "plain" = "plain",
): ReactNode {
  switch (value.kind) {
    case "empty":
      return value.raw === undefined ? undefined : <NoneValue />;
    case "timestamp":
      return <HoverableTimestamp timestamp={value.raw} />;
    case "date":
      return format(parsePlainDate(value.raw), "MMM d, yyyy");
    case "boolean":
      return value.raw ? "Yes" : "No";
    case "number":
      return value.raw;
    case "list":
      return value.raw.length ? value.raw.join(", ") : <NoneValue />;
    case "json":
      return <StructuredValue value={value} surface={surface} />;
    case "enum":
      if (surface === "plain") return value.label;
      return (
        <EnumPill
          color={value.color}
          icon={value.icon}
          description={value.description}
        >
          {value.label}
        </EnumPill>
      );
    case "text":
      if (surface === "plain") return value.label || <NoneValue />;
      if (!value.label) return <NoneValue />;
      return surface === "list" ? (
        <ListTextValue label={value.label} />
      ) : (
        <span className="break-words whitespace-pre-wrap">{value.label}</span>
      );
  }
}
