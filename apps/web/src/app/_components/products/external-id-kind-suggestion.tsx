import type { FieldValues, Path, UseFormReturn } from "react-hook-form";
import { useWatch } from "react-hook-form";

import { basisValueOf } from "~/app/_components/ai/field-suggestion";
import { FieldSuggestionHint } from "~/app/_components/ai/field-suggestion-hint";
import { useRowEnumSuggestion } from "~/app/_components/ai/use-row-enum-suggestion";
import { ai } from "~/lib/ai.functions";

/** Row values that mean "no kind picked yet" — the array's default
 * (`legacy_unspecified`, `ProductExternalIds`'s `emptyValue`) and a blank
 * select both count, so this fires on a freshly-added row, not just an
 * edited one. */
const UNSET_KIND_VALUES = ["", "legacy_unspecified"];
/** A source/identifier shorter than this carries no shape signal —
 * `externalIdKindSuggestionInput.identifier` itself requires 2. */
const MIN_IDENTIFIER_LENGTH = 2;

/**
 * One external-ID row's Kind hint, mounted under the Kind select
 * (`ProductExternalIdsField`, `entities/editing/product-editor-fields.tsx`).
 * Binds the generic
 * `useRowEnumSuggestion` to `ai.suggestExternalIdKind` — server-side regex
 * fast paths answer the common shapes (ASIN, barcode) with no model call;
 * everything else goes to Jev.
 */
export function ExternalIdKindSuggestion<TFieldValues extends FieldValues>({
  form,
  kindPath,
  sourcePath,
  externalIdPath,
  urlPath,
  productName,
  manufacturer,
}: {
  form: UseFormReturn<TFieldValues>;
  kindPath: Path<TFieldValues>;
  sourcePath: Path<TFieldValues>;
  externalIdPath: Path<TFieldValues>;
  urlPath: Path<TFieldValues>;
  productName?: string | null;
  manufacturer?: string | null;
}) {
  // Watched together (not just source/identifier/url) so this re-renders on
  // its own suggestion write or a manual pick, the way a `Controller`-nested
  // `AutoSuggestSlot` gets that for free from its parent's field subscription.
  const watched = useWatch({
    control: form.control,
    name: [kindPath, sourcePath, externalIdPath, urlPath],
  });
  const currentKind = basisValueOf(watched[0]);
  const source = basisValueOf(watched[1]);
  const identifier = basisValueOf(watched[2]);
  const url = basisValueOf(watched[3]);
  const enabled =
    source != null && (identifier?.length ?? 0) >= MIN_IDENTIFIER_LENGTH;

  const basis = {
    source: source ?? "",
    identifier: identifier ?? "",
    url,
    productName: basisValueOf(productName),
    manufacturer: basisValueOf(manufacturer),
  };

  const { suggestion, isPending, applied, apply } = useRowEnumSuggestion({
    queryOptions: (b) => ai.suggestExternalIdKind.queryOptions(b),
    basis,
    enabled,
    form,
    path: kindPath,
    unsetValues: UNSET_KIND_VALUES,
  });

  return (
    <FieldSuggestionHint
      suggestion={suggestion}
      applied={applied}
      onApply={apply}
      pending={isPending}
      currentValue={currentKind}
    />
  );
}
