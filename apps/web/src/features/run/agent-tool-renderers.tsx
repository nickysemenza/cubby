import { countLabel } from "@cubby/shared/pluralize";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import type { ReactNode } from "react";
import { z } from "zod";

import { ShortcodeProse } from "~/entity/prose/shortcode-prose";

const jsonValue = z.json();
type JsonValue = z.infer<typeof jsonValue>;

/** A recorded call under its display name (`tool.action`). */
export type ToolCall = {
  name: string;
  input: JsonValue;
  output: JsonValue | undefined;
};

type ToolRenderer = {
  /** The collapsed line's text after the tool name. */
  summary?: (call: ToolCall) => string | null;
  /** Replaces the JSON payloads for a successful call; the raw JSON stays one click away. */
  render?: (call: ToolCall) => ReactNode;
};

const STRUCTURED_PREFIX = "Structured content:\n";

/**
 * A tool payload as JSON. pi transcripts already hold parsed results; other
 * harnesses recorded MCP text, sometimes behind a "Structured content:" line.
 */
function parseToolValue(value: JsonValue | undefined): JsonValue | undefined {
  const text = z.string().safeParse(value);
  if (!text.success) return value;
  const source = text.data.startsWith(STRUCTURED_PREFIX)
    ? text.data.slice(STRUCTURED_PREFIX.length)
    : text.data;
  try {
    return jsonValue.parse(JSON.parse(source));
  } catch {
    return text.data;
  }
}

export function formatToolValue(value: JsonValue | undefined): string {
  if (value === undefined) return "No output";
  const parsed = parseToolValue(value);
  return typeof parsed === "string"
    ? parsed
    : (JSON.stringify(parsed, null, 2) ?? "null");
}

const SUMMARY_FIELDS = 3;
const SUMMARY_VALUE_CHARS = 40;

/** Up to three scalar arguments as `key=value`; `action` is already in the name. */
function scalarSummary(input: JsonValue): string | null {
  const record = z.record(z.string(), z.unknown()).safeParse(input);
  if (!record.success) return null;
  const fields = Object.entries(record.data)
    .filter(
      ([key, value]) =>
        key !== "action" &&
        !key.startsWith("_") &&
        ["string", "number", "boolean"].includes(typeof value),
    )
    .slice(0, SUMMARY_FIELDS)
    .map(([key, value]) => {
      const text =
        typeof value === "string" ? JSON.stringify(truncate(value)) : value;
      return `${key}=${String(text)}`;
    });
  return fields.length ? fields.join(" ") : null;
}

function truncate(text: string): string {
  return text.length > SUMMARY_VALUE_CHARS
    ? `${text.slice(0, SUMMARY_VALUE_CHARS - 1)}…`
    : text;
}

// ── entity.commands ─────────────────────────────────────────────────────

const commandsInput = z.object({
  commands: z.array(
    z.object({
      action: z.string(),
      entity: z.string(),
      id: z.string().optional(),
      data: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
});
const commandsOutput = z.object({
  summary: z.object({ succeeded: z.number(), failed: z.number() }),
  results: z.array(
    z.object({
      index: z.number(),
      status: z.enum(["succeeded", "failed"]),
      reference: z.string().optional(),
      error: z.object({ message: z.string() }).optional(),
    }),
  ),
});

const entityCommands: ToolRenderer = {
  summary: ({ input, output }) => {
    const commands = commandsInput.safeParse(input).data?.commands;
    const result = commandsOutput.safeParse(parseToolValue(output)).data;
    if (!commands) return null;
    const kinds = [
      ...new Set(commands.map((c) => `${c.action} ${c.entity}`)),
    ].join(", ");
    const outcome = result
      ? ` · ${result.summary.succeeded} ok${result.summary.failed ? ` · ${result.summary.failed} failed` : ""}`
      : "";
    return `${countLabel(commands.length, "command")} (${truncate(kinds)})${outcome}`;
  },
  render: ({ input, output }) => {
    const commands = commandsInput.safeParse(input).data?.commands;
    const result = commandsOutput.safeParse(parseToolValue(output)).data;
    if (!commands) return null;
    return (
      <ResultList label="Commands">
        {commands.map((command, index) => {
          const outcome = result?.results.find((r) => r.index === index);
          const name = z
            .string()
            .safeParse(command.data?.name ?? command.data?.title).data;
          return (
            <ResultRow
              // Commands are positional; the index is their identity.
              // oxlint-disable-next-line react/no-array-index-key
              key={index}
              ok={outcome ? outcome.status === "succeeded" : undefined}
              primary={`${command.action} ${command.entity}`}
              secondary={[
                outcome?.reference ?? command.id,
                name ? JSON.stringify(truncate(name)) : null,
                command.data ? Object.keys(command.data).join(", ") : null,
                outcome?.error?.message,
              ]}
            />
          );
        })}
      </ResultList>
    );
  },
};

// ── search and entity reads ─────────────────────────────────────────────

const searchHit = z.object({
  id: z.string(),
  entityKind: z.string(),
  title: z.string(),
  subtitle: z.string().nullish(),
});
type SearchHit = z.infer<typeof searchHit>;
const hitsOutput = z.union([
  z.object({
    results: z.array(z.union([searchHit, z.object({ entity: searchHit })])),
    related: z.array(searchHit).optional(),
  }),
  z.object({
    lexical: z.array(searchHit),
    semantic: z.object({ results: z.array(searchHit) }).optional(),
  }),
]);
const itemsOutput = z.object({
  entity: z.string(),
  item: z.object({ id: z.string(), name: z.string().optional() }).nullish(),
  items: z
    .array(z.object({ id: z.string(), name: z.string().optional() }))
    .optional(),
});

type ReadRecord = { id: string; kind: string; title: string };

function readRecords(output: JsonValue | undefined): ReadRecord[] | null {
  const value = parseToolValue(output);
  const hits = hitsOutput.safeParse(value).data;
  if (hits) {
    const list: SearchHit[] =
      "lexical" in hits
        ? [...hits.lexical, ...(hits.semantic?.results ?? [])]
        : [
            ...hits.results.map((hit) => ("entity" in hit ? hit.entity : hit)),
            ...(hits.related ?? []),
          ];
    const seen = new Set<string>();
    return list.flatMap((hit) => {
      if (seen.has(hit.id)) return [];
      seen.add(hit.id);
      return [{ id: hit.id, kind: hit.entityKind, title: hit.title }];
    });
  }
  const items = itemsOutput.safeParse(value).data;
  if (!items) return null;
  return [...(items.item ? [items.item] : []), ...(items.items ?? [])].map(
    (item) => ({
      id: item.id,
      kind: items.entity,
      title: item.name ?? item.id,
    }),
  );
}

const entityReads: ToolRenderer = {
  summary: (call) => {
    const query = z.object({ query: z.string() }).safeParse(call.input).data;
    const records = readRecords(call.output);
    const head = query
      ? JSON.stringify(truncate(query.query))
      : scalarSummary(call.input);
    if (!records) return head;
    return [head, countLabel(records.length, "result")]
      .filter(Boolean)
      .join(" · ");
  },
  render: ({ output }) => {
    const records = readRecords(output);
    if (!records) return null;
    if (!records.length)
      return <p className="text-xs text-muted-foreground">No records.</p>;
    return (
      <ResultList label="Records">
        {records.map((record) => (
          <ResultRow
            key={record.id}
            primary={record.title}
            secondary={[record.id, record.kind]}
          />
        ))}
      </ResultList>
    );
  },
};

// ── purchase_import.commit ──────────────────────────────────────────────

const commitOutput = z.object({
  status: z.string(),
  items: z.array(
    z.object({
      stableOrderId: z.string(),
      outcome: z.string(),
      purchaseId: z.string().nullable(),
      findingCount: z.number(),
    }),
  ),
});

const purchaseCommit: ToolRenderer = {
  summary: ({ input, output }) => {
    const result = commitOutput.safeParse(parseToolValue(output)).data;
    if (!result) {
      const resolutions = z
        .object({ resolutions: z.array(z.unknown()) })
        .safeParse(input).data?.resolutions;
      return resolutions ? countLabel(resolutions.length, "resolution") : null;
    }
    const counts = new Map<string, number>();
    for (const item of result.items)
      counts.set(item.outcome, (counts.get(item.outcome) ?? 0) + 1);
    return [
      countLabel(result.items.length, "order"),
      ...[...counts].map(([outcome, count]) => `${count} ${outcome}`),
      result.status,
    ].join(" · ");
  },
  render: ({ output }) => {
    const result = commitOutput.safeParse(parseToolValue(output)).data;
    if (!result) return null;
    return (
      <ResultList label="Committed orders">
        {result.items.map((item) => (
          <ResultRow
            key={item.stableOrderId}
            ok={item.outcome !== "conflict"}
            primary={`${item.outcome} ${item.stableOrderId}`}
            secondary={[
              item.purchaseId,
              item.findingCount
                ? countLabel(item.findingCount, "finding")
                : null,
            ]}
          />
        ))}
      </ResultList>
    );
  },
};

const RENDERERS = {
  "entity.commands": entityCommands,
  "search.*": entityReads,
  "entity_read.get": entityReads,
  "entity_read.list": entityReads,
  "entity_read.search": entityReads,
  "purchase_import.commit": purchaseCommit,
} satisfies Record<string, ToolRenderer>;

/** The renderer for `tool.action`, falling back to a `tool.*` registration. */
export function toolRenderer(name: string): ToolRenderer | undefined {
  const key = [name, `${name.split(".")[0]}.*`].find((candidate) =>
    Object.hasOwn(RENDERERS, candidate),
  );
  // SAFETY: `Object.hasOwn` just proved `key` is one of the registry's keys.
  return key ? RENDERERS[key as keyof typeof RENDERERS] : undefined;
}

export function toolSummary(call: ToolCall): string | null {
  return toolRenderer(call.name)?.summary?.(call) ?? scalarSummary(call.input);
}

function ResultList({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <ul aria-label={label} className="grid gap-0.5 text-xs">
      {children}
    </ul>
  );
}

function ResultRow({
  ok,
  primary,
  secondary,
}: {
  ok?: boolean;
  primary: string;
  secondary: ReadonlyArray<string | null | undefined>;
}) {
  const detail = secondary.filter(Boolean).join(" · ");
  return (
    <li className="flex min-w-0 items-baseline gap-1.5">
      {ok === undefined ? null : ok ? (
        <CheckIcon
          aria-label="Succeeded"
          className="size-3 shrink-0 self-center text-positive"
        />
      ) : (
        <XIcon
          aria-label="Failed"
          className="size-3 shrink-0 self-center text-destructive"
        />
      )}
      <span className="shrink-0 font-medium text-foreground">{primary}</span>
      {detail ? (
        <span className="min-w-0 truncate text-muted-foreground">
          <ShortcodeProse>{detail}</ShortcodeProse>
        </span>
      ) : null}
    </li>
  );
}
