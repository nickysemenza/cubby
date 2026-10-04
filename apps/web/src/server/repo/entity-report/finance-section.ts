import type { Entity } from "@cubby/schemas/entity-core";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import type { ReportBlock } from "@cubby/schemas/entity-report";

import { formatCurrency } from "~/lib/utils";

type Records = Extract<ReportBlock, { kind: "records" }>;
type SectionAction = NonNullable<Records["verbs"]>[number];

/** What a section composes per row before it is worded as a records row. */
type SectionItem = {
  id: string;
  title: string;
  lines: string[];
  amount: number | null;
  amountNote: string | null;
  badge: string | null;
  link: { entity: string; id: string; label: string | null } | null;
  disabledReason: string | null;
};

/** A key-value row of a finance section; a pill carries the declared option's colour. */
type SectionRow = {
  label: string;
  value:
    | { type: "text"; text: string }
    | { type: "money"; amount: number | null }
    | { type: "pill"; text: string; color: string | null };
};

/** What the finance detail slots compose: rows, notes, and an optional list with its verbs. */
export interface Section {
  rows: SectionRow[];
  notes: string[];
  /** Null when the section draws no list. */
  items: SectionItem[] | null;
  emptyText: string | null;
  footer: string | null;
  actions: SectionAction[];
}

/** A section with only the parts it draws. */
export const sectionOut = (parts: Partial<Section>): Section => ({
  rows: [],
  notes: [],
  items: null,
  emptyText: null,
  footer: null,
  actions: [],
  ...parts,
});

/**
 * The colour a declared enum option carries (`var(--positive)`), so a verdict pill is the one the
 * list and detail already draw.
 */
export const optionColor = (
  entity: Entity,
  field: string,
  value: string,
): string | null =>
  entityFieldModels[entity].fields
    .find((candidate) => candidate.key === field)
    ?.display.valueOptions?.find((option) => option.value === value)?.color ??
  null;

/** The tone of a declared option colour; anything else (slate) reads as muted. */
const toneOf = (color: string | null): ReportBlockTone => {
  switch (color) {
    case "var(--positive)":
      return "positive";
    case "var(--warning)":
      return "warning";
    case "var(--destructive)":
      return "destructive";
    default:
      return "muted";
  }
};

type RecordRow = Extract<ReportBlock, { kind: "records" }>["rows"][number];

/** One section item as a records row; the row's `key` is what a checked row names. */
const recordRow = (item: SectionItem): RecordRow => {
  const row: RecordRow = {
    entity: item.link?.entity ?? null,
    id: item.link?.id ?? null,
    title: item.title,
    subtitle: item.lines.length > 0 ? item.lines.join("\n") : null,
    trailing:
      item.amount === null
        ? null
        : item.amountNote
          ? `${formatCurrency(item.amount)} ${item.amountNote}`
          : formatCurrency(item.amount),
    key: item.id,
    disabledReason: item.disabledReason,
  };
  if (item.badge) row.badges = [item.badge];
  return row;
};

/** The report blocks for a section: its rows as stats, notes as notes, its list as records. */
export function sectionBlocks(section: Section): ReportBlock[] {
  const blocks: ReportBlock[] = [];
  if (section.rows.length > 0)
    blocks.push({
      kind: "stats",
      figures: section.rows.map(({ label, value }) => {
        switch (value.type) {
          case "money":
            return { label, value: value.amount, format: "money" as const };
          case "text":
            return {
              label,
              value: null,
              format: "text" as const,
              text: value.text,
            };
          case "pill":
            return {
              label,
              value: null,
              format: "text" as const,
              text: value.text,
              tone: toneOf(value.color),
            };
        }
      }),
    });
  for (const text of section.notes) blocks.push({ kind: "note", text });
  if (section.items !== null || section.actions.length > 0) {
    const records: Extract<ReportBlock, { kind: "records" }> = {
      kind: "records",
      rows: (section.items ?? []).map(recordRow),
      empty: section.emptyText ?? "",
      actions: [],
      verbs: section.actions,
    };
    if (section.footer !== null) records.footer = section.footer;
    blocks.push(records);
  }
  return blocks;
}

type ReportBlockTone = "positive" | "warning" | "destructive" | "muted";
