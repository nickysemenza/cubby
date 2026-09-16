import type { VendorFilters, VendorOut } from "@cubby/schemas/vendor";
import { useMemo } from "react";

import { useNameEditable } from "~/app/_components/hooks/useNameEditable";
import { useUpdateMutation } from "~/app/_components/hooks/useUpdateMutation";
import { entityMutationOptionsFactory } from "~/entities/entity-contracts";

import { defineListOverride } from "./types";

/**
 * Every vendor column is declared `display` on `11-vendor.entity.ts`; the
 * only hand-written pieces are inline name editing and the name width (a
 * sparse table would otherwise balloon the name column).
 */
export const vendorListOverride = defineListOverride<VendorOut, VendorFilters>({
  use() {
    const updateVendorMutation = useUpdateMutation({
      mutationFn: entityMutationOptionsFactory("vendor", "update"),
      entity: "vendor",
    });
    const nameEditable = useNameEditable<VendorOut>(
      updateVendorMutation.mutateAsync,
    );
    const list = useMemo(
      () => ({
        deletable: true as const,
        nameEditable,
        nameClassName: "w-64",
      }),
      [nameEditable],
    );
    return { list };
  },
});
