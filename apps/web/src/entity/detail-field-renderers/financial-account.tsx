import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { fieldEnumOptions } from "~/entity/enum-field-display";
import { renderOptionCell } from "~/ui/data-table/columnHelpers";

import type { EntityDetailFieldRenderers } from "./index";

/**
 * Only the identity kind keeps a web cell: its pill and the "show all such
 * accounts" filter link. The aliases and card numbers print the text the server
 * composed (`display.detailLabelPath`).
 */
export const financialAccountDetailFields = {
  "financial-account-identity": (account) => ({
    value: renderOptionCell(
      account.identity.kind,
      fieldEnumOptions("financialAccount", "identity"),
    ),
    filterAction: (
      <EntityRefLink
        variant="filter"
        to="/financial-accounts"
        search={{ identity: account.identity.kind }}
        label={`Show all ${account.identity.kind.replaceAll("_", " ")} accounts`}
      />
    ),
  }),
} satisfies EntityDetailFieldRenderers<"financialAccount">;
