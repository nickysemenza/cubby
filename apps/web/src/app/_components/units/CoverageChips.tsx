import type { UnitMapping } from "@cubby/schemas/unitmapping";
import { MACRO_KEYS } from "@cubby/usda-schemas";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";

import { Row } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { BASE_KINDS } from "~/lib/conversion-coverage";

import { macroCoverage } from "./macro-coverage";

const KIND_LABEL = {
  weight: "weight",
  volume: "volume",
  money: "price",
  calories: "calories",
} satisfies Record<(typeof BASE_KINDS)[number], string>;

/** A lit/dim coverage pill — the shared vocabulary for big-4 + macro chips. */
function chip(key: string, label: string, on: boolean) {
  return (
    <Badge
      key={key}
      variant={on ? "secondary" : "outline"}
      className={on ? undefined : "text-muted-foreground"}
    >
      {on && <CheckIcon className="mr-1 size-3" />}
      {label}
    </Badge>
  );
}

/**
 * The four base measurement kinds, lit when the graph can already reach them.
 * When `usdaLinked` is provided, also shows a "USDA" chip — so it's clear
 * whether a gap (e.g. calories) is because nothing's linked, or because the
 * linked food simply has no data for that kind.
 *
 * `applicable` (the kinds graded against — see `gradedKinds`) splits the unlit
 * chips into two: a kind that's applicable but unreached is a real gap (faded);
 * a kind the user marked N/A is struck through ("—" / not applicable), so a
 * count-only ingredient doesn't read as missing a volume it never uses. Omitting
 * `applicable` grades all four (legacy callers / placeholders).
 */
export function CoverageChips({
  covered,
  applicable,
  usdaLinked,
}: {
  covered: string[];
  applicable?: string[];
  usdaLinked?: boolean;
}) {
  const lit = new Set(covered);
  const na = applicable
    ? new Set(BASE_KINDS.filter((k) => !applicable.includes(k)))
    : new Set<string>();
  return (
    <Row gap="xs" wrap>
      {BASE_KINDS.map((kind) =>
        na.has(kind) ? (
          <Badge
            key={kind}
            variant="outline"
            className="text-muted-foreground line-through"
            title="not applicable"
          >
            {KIND_LABEL[kind]}
          </Badge>
        ) : (
          chip(kind, KIND_LABEL[kind], lit.has(kind))
        ),
      )}
      {usdaLinked !== undefined && chip("usda", "USDA", usdaLinked)}
    </Row>
  );
}

/**
 * The macro nutrients (protein/fat/carbs/fiber/sodium) the recipe nutrition
 * table consumes, lit when the product's graph carries that `nutrient:*` edge.
 * Same chip vocabulary as {@link CoverageChips}. Renders nothing when the
 * product has no macro mappings at all (non-food products don't get an all-dim
 * row). Hidden macros (a food missing fiber/sodium) read as a faded gap.
 */
export function MacroChips({ mappings }: { mappings: UnitMapping[] }) {
  const present = macroCoverage(mappings);
  if (present.size === 0) return null;
  return (
    <Row gap="xs" wrap align="center">
      <span className="text-2xs tracking-wide text-muted-foreground uppercase">
        macros
      </span>
      {MACRO_KEYS.map((key) => chip(key, key, present.has(key)))}
    </Row>
  );
}
