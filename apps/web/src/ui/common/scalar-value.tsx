import type { EnumIcon, EnumRole } from "@cubby/shared/enum-palette";
import type { ReactNode } from "react";
import { z } from "zod";

import { formatCount } from "~/lib/number-format";
import { DateDisplay } from "~/ui/common/date-display";
import { MiddleTruncate } from "~/ui/common/middle-truncate";
import { Disclosure } from "~/ui/layout/disclosure";
import { BooleanValue, EnumPill } from "~/ui/primitives/enum-pill";
import { NoneValue } from "~/ui/primitives/none-value";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "~/ui/primitives/popover";
import JsonRenderer from "~/ui/text/json-renderer";

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
      /** Roster role: states take a tone surface; kinds take a quiet matching tint. */
      role?: EnumRole;
      glyph?: EnumIcon | null;
      description?: string;
    }
  | { kind: "number"; raw: number }
  | { kind: "boolean"; raw: boolean }
  /** `due`: an open record's deadline, tinted once it has passed. */
  | { kind: "date"; raw: string; due?: boolean }
  | { kind: "timestamp"; raw: string | Date }
  | { kind: "list"; raw: string[] }
  /** A structured value with no domain renderer; shown as readable JSON. */
  | { kind: "json"; raw: unknown };

/** A plain number with locale grouping; a zero is a quiet fact, never a dash. */
export function NumberValue({ value }: { value: number }) {
  return (
    <span className={value === 0 ? "text-muted-foreground" : undefined}>
      {formatCount(value, 20)}
    </span>
  );
}

function ListTextValue({ label }: { label: string }) {
  return <MiddleTruncate text={label} title={label} />;
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
      <Disclosure summary={summary} className="max-w-full">
        <div className="max-h-80 max-w-full overflow-auto text-xs">
          <JsonRenderer input={value.raw} />
        </div>
      </Disclosure>
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
      return <DateDisplay timestamp={value.raw} />;
    case "date":
      return <DateDisplay start={value.raw} due={value.due} />;
    case "boolean":
      return surface === "plain" ? (
        value.raw ? (
          "Yes"
        ) : (
          "No"
        )
      ) : (
        <BooleanValue value={value.raw} />
      );
    case "number":
      return surface === "plain" ? (
        value.raw
      ) : (
        <NumberValue value={value.raw} />
      );
    case "list":
      return value.raw.length ? value.raw.join(", ") : <NoneValue />;
    case "json":
      return <StructuredValue value={value} surface={surface} />;
    case "enum":
      if (surface === "plain") return value.label;
      return (
        <EnumPill
          value={value.raw}
          optionRole={value.role}
          glyph={value.glyph}
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
