import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import { CalendarIcon } from "@phosphor-icons/react/dist/csr/Calendar";
import type { ReactNode } from "react";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { entityLabel, isBrowserRoutedEntity } from "~/entity/entities";
import { DateDisplay } from "~/ui/common/date-display";
import type { Fact } from "~/ui/common/facts";
import { Row } from "~/ui/layout";

type FactInput = Fact | null | undefined | false | "";

/** Drop absent facts so a row lists only what it knows. */
export const facts = (...entries: FactInput[]): Fact[] =>
  entries.filter((entry): entry is Fact => Boolean(entry));

export const fact = (
  label: string,
  value: ReactNode,
  tone?: Fact["tone"],
): Fact => ({ label, value, tone });

/**
 * `Product.manufacturer` is free text, so a fact rather than a link. Absent
 * stays absent unless the card is about identity, where the gap is the defect.
 */
export const manufacturerFact = (
  manufacturer: string | null | undefined,
  { missingIsDefect = false }: { missingIsDefect?: boolean } = {},
): Fact | null =>
  manufacturer
    ? fact("Manufacturer", manufacturer)
    : missingIsDefect
      ? fact("Manufacturer", "—", "warning")
      : null;

/**
 * Records a row names besides its own, as linked chips under one label
 * (defaulting to the entity's name). A non-routed entity renders its names
 * as text.
 */
export function recordFact(
  entity: ShortcodeEntity,
  refs: readonly { id: string; name: string }[],
  label: string = entityLabel(entity),
): Fact | null {
  if (!refs.length) return null;
  return {
    id: `record:${entity}`,
    label,
    value: (
      <span className="inline-flex max-w-full min-w-0 flex-wrap gap-x-2 gap-y-0.5">
        {refs.map((ref) =>
          isBrowserRoutedEntity(entity) ? (
            <EntityRefLink
              key={ref.id}
              variant="chip"
              entity={entity}
              id={ref.id}
              name={ref.name}
            />
          ) : (
            <span key={ref.id}>{ref.name}</span>
          ),
        )}
      </span>
    ),
    title: refs.map((ref) => ref.name).join(", "),
  };
}

/** Muted "Created N ago" detail row, keyed for use in a `details` array. */
export function createdAgoDetail(createdAt: Date | string | number): ReactNode {
  return (
    <Row
      key="created"
      align="center"
      gap="xs"
      className="text-sm text-muted-foreground"
    >
      <CalendarIcon className="size-3" />
      Created <DateDisplay timestamp={createdAt} />
    </Row>
  );
}

/** Muted location detail row with the location entity icon. */
/** Inline monospace chip used for UPCs and raw amounts in badge rows. */
export function CodeChip({ children }: { children: ReactNode }) {
  return <code className="bg-muted px-2 py-1 text-sm">{children}</code>;
}
