import type { VendorKind } from "@cubby/schemas/vendor";
import { VENDOR_KIND_LABELS, vendorKindValues } from "@cubby/schemas/vendor";
import type { BadgeVariant } from "~/components/ui/badge";
import type { FilterableComboboxItem } from "~/components/ui/combobox";

/**
 * Vendor picklists and chip theming — a leaf module (no table/hook imports) so
 * both the list page and the detail page's inline editors can read it, mirroring
 * `app/projects/trade-options.tsx`.
 */

/** The kind picklist, for the list's header filter and both inline editors. */
export const vendorKindOptions: FilterableComboboxItem[] = vendorKindValues.map(
  (value) => ({ value, label: VENDOR_KIND_LABELS[value] }),
);

/**
 * One tone per kind. A finite-key `Record`, not a `match()` — see the root
 * CLAUDE.md carve-out for enum→theme lookups.
 */
export const VENDOR_KIND_BADGE_VARIANT: Record<VendorKind, BadgeVariant> = {
  retailer: "default",
  contractor: "plum",
  supplier: "slate",
  other: "outline",
};
