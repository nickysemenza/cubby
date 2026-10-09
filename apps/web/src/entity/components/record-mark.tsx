import type { Entity } from "@cubby/schemas/entity";
import {
  type ShortcodeEntity,
  shortcodeEntities,
} from "@cubby/schemas/entity-index";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useMemo } from "react";

import { entityFilterOptions } from "~/integrations/tanstack-query/generated/entity-filter-options.gen";
import { useEntityOptions } from "~/ui/hooks/useEntityOptions";

import { RecordEmoji } from "./record-emoji";

export type RecordMarkSize = 12 | 14 | 20;

/** A record emoji with its declaration-owned type symbol as the fallback. */
export function RecordMark({
  entity,
  emoji,
  size = 14,
  className,
}: {
  entity: ShortcodeEntity;
  emoji: string | null | undefined;
  size?: RecordMarkSize;
  className?: string;
}) {
  return (
    <RecordEmoji
      entity={entity}
      emoji={emoji}
      size={size}
      className={className}
    />
  );
}

/** Shared identity roster keyed by shortcode. */
export function useRecordEmojiById(
  entity: ShortcodeEntity,
  options: { enabled?: boolean } = {},
) {
  const { items, isLoading } = useEntityOptions(entity, {
    include: ["emoji"],
    enabled: options.enabled,
  });
  const emojiById = useMemo(
    () => new Map(items.map((item) => [item.id, item.emoji ?? null])),
    [items],
  );
  return { emojiById, isLoading };
}

/**
 * Resolves relation-only links through the lightweight options query.
 * Explicit emoji values skip the lookup.
 */
export function RecordMarkById({
  entity,
  recordId,
  emoji,
  size = 14,
  className,
  fallback,
}: {
  entity: ShortcodeEntity;
  recordId: string;
  /** `undefined` means not loaded; `null` means known-empty. */
  emoji?: string | null;
  size?: RecordMarkSize;
  className?: string;
  fallback?: ReactNode;
}) {
  const { data } = useQuery({
    ...entityFilterOptions.filterOptions.queryOptions({
      source: "entity",
      entity,
      search: "",
      selectedIds: [recordId],
      include: ["emoji"],
      limit: 1,
    }),
    enabled: emoji === undefined,
  });
  const resolvedIcon =
    emoji === undefined
      ? (data?.items.find((item) => item.id === recordId)?.emoji ?? null)
      : emoji;

  if (!resolvedIcon && fallback) return fallback;
  return (
    <RecordMark
      entity={entity}
      emoji={resolvedIcon}
      size={size}
      className={className}
    />
  );
}

export type RecordChartIdentity = {
  name: string;
  emoji: string | null | undefined;
};

/** Shared HTML label for chart tooltips and other visualization chrome. */
export function RecordChartLabel({
  entity,
  identity,
}: {
  entity: ShortcodeEntity;
  identity: RecordChartIdentity;
}) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <RecordMark entity={entity} emoji={identity.emoji} size={12} />
      <span className="truncate">{identity.name}</span>
    </span>
  );
}

/**
 * Nivo's left axis is SVG, so a small foreignObject lets the same HTML mark
 * render beside a truncated project name instead of falling back to text-only
 * ticks. The surrounding chart owns the identity map and performs one lookup
 * per tick.
 */
export function RecordChartTick({
  entity,
  x,
  y,
  value,
  identityById,
  width = 160,
}: {
  entity: ShortcodeEntity;
  x: number;
  y: number;
  value: string | number;
  identityById: ReadonlyMap<string, RecordChartIdentity>;
  width?: number;
}) {
  const identity = identityById.get(String(value));
  if (!identity) return <g transform={`translate(${x}, ${y})`} />;

  return (
    <g transform={`translate(${x}, ${y})`}>
      <foreignObject x={-width} y={-10} width={width - 4} height={20}>
        <div
          className="flex h-5 items-center justify-end gap-1 overflow-hidden pr-1 text-xs text-foreground"
          title={identity.name}
        >
          <RecordMark entity={entity} emoji={identity.emoji} size={12} />
          <span className="truncate">{identity.name}</span>
        </div>
      </foreignObject>
    </g>
  );
}

/** References without hydrated marks use the same shared roster as identity charts. */
export function RecordMarkByReference({
  entity,
  recordId,
  emoji,
  size = 12,
  fallback,
}: {
  entity: Entity;
  recordId: string;
  emoji?: string | null;
  size?: RecordMarkSize;
  fallback?: ReactNode;
}) {
  const isShortcode = (value: Entity): value is ShortcodeEntity =>
    shortcodeEntities.some((candidate) => candidate === value);
  return isShortcode(entity) ? (
    <RecordMarkById
      entity={entity}
      recordId={recordId}
      emoji={emoji}
      size={size}
      fallback={fallback}
    />
  ) : (
    <RecordEmoji entity={entity} emoji={emoji} size={size} />
  );
}
