import type { VendorFilters, VendorOut } from "@cubby/schemas/vendor";
import { useMemo } from "react";

import { EntityListPage } from "~/app/_components/data-table/EntityListPage";
import { createCubbyColumnHelper } from "~/app/_components/data-table/table-features";
import { useNameEditable } from "~/app/_components/hooks/useNameEditable";
import { useUpdateMutation } from "~/app/_components/hooks/useUpdateMutation";
import { entityMutationOptionsFactory } from "~/entities/entity-contracts";
import { createEntityDisplayColumns } from "~/entities/entity-display";
import { entityListFor } from "~/entities/entity-list.functions";

export function VendorList() {
  const columnHelper = useMemo(() => createCubbyColumnHelper<VendorOut>(), []);

  const updateVendorMutation = useUpdateMutation({
    mutationFn: entityMutationOptionsFactory("vendor", "update"),
    entity: "vendor",
  });

  const nameEditable = useNameEditable<VendorOut>(
    updateVendorMutation.mutateAsync,
  );

  // Website (external-link), Purchases, Spend (signedCurrency, footer reads
  // the server's exact `sums.spend` over the whole filtered set) and Latest
  // purchase (plainDate) are all declared `display` on
  // `11-vendor.entity.ts` now — no page-level column overrides.
  const columns = useMemo(
    () => createEntityDisplayColumns<VendorOut>("vendor", columnHelper),
    [columnHelper],
  );

  // Neither `buildFilters` nor `filters` is passed: the `vendor` entry in
  // `entities/filter-manifest.tsx` drives all three surfaces at once — the Name
  // search box, the server `VendorFilters` object, and the `?q=` URL round-trip
  // that makes a filtered roster shareable. The roster opens on biggest
  // spenders first — see `model.sort.default` on
  // `packages/schemas/src/entity-definitions/11-vendor.entity.ts`.
  //
  // Delete comes from the vendor contract: `deleteVendors` refuses while live
  // purchases still point at the vendor (VENDOR_HAS_PURCHASES) — the server
  // message surfaces in the delete dialog's error toast, which is the intended
  // UX: re-point the purchases first.
  return (
    <EntityListPage<VendorOut, VendorFilters>
      entity="vendor"
      queryOptions={entityListFor("vendor").listQueryPlan}
      columns={columns}
      nameEditable={nameEditable}
      // Sparse table (four columns), so the name gets a fixed width instead of
      // ballooning to absorb the leftover space under the fixed layout.
      nameClassName="w-64"
      // The roster reads by brand: the same mark the ledger's vendor cell leads
      // with, so a vendor looks identical wherever it appears. `VendorMark` falls
      // back to a monogram tile, so every row carries something (roughly half the
      // roster is one-off local trades with no logo). It's a fixed-width
      // `shrink-0` glyph, so the name keeps truncating at `w-64`.
      ariaLabel="Vendors Table"
    />
  );
}
