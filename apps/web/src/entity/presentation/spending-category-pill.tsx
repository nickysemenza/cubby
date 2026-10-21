import { entitySummary } from "@cubby/schemas/entity-summary";
import { Link } from "@tanstack/react-router";

import { RecordEmoji } from "~/entity/components/record-emoji";
import { EnumPill } from "~/ui/primitives/enum-pill";

// The declared tint: spending categories wear their wayfinding domain's hue.
const SPENDING_CATEGORY_TINT = `var(--brand-domain-${entitySummary.spendingCategory.domain})`;

/**
 * A spending category's emoji and label on its finance-tinted pill, linked to
 * the category when `id` is known. Kept free of list reads so reference links
 * can render it; `SpendingCategoryLabel` adds the full path.
 */
export function SpendingCategoryPill({
  id,
  label,
  emoji,
}: {
  id?: string | null;
  label: string;
  emoji?: string | null;
}) {
  const pill = (
    <EnumPill
      color={SPENDING_CATEGORY_TINT}
      icon={<RecordEmoji entity="spendingCategory" emoji={emoji} size={12} />}
      className={
        id ? "transition-colors group-hover:border-current" : undefined
      }
    >
      {label}
    </EnumPill>
  );
  if (!id) return pill;
  return (
    <Link
      to="/spending-categories/$shortcode"
      params={{ shortcode: id }}
      title={label}
      className="group inline-flex max-w-full min-w-0 outline-none focus-visible:ring-2 focus-visible:ring-ring"
      // A clickable row must not also open its own record.
      onClick={(event) => event.stopPropagation()}
    >
      {pill}
    </Link>
  );
}
