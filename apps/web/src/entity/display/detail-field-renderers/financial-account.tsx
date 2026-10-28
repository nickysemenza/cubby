import { EntityFilterLink } from "~/entity/components/entity-ref-link";
import { fieldEnumOptions } from "~/entity/display/enum-field-display";
import { renderOptionCell } from "~/entity/table/column-helpers";

import type { EntityDetailFieldRenderers } from "./index";

/**
 * Only the identity kind keeps a web cell: its pill and the "show all such
 * accounts" filter link. The aliases and card numbers print the text the server
 * composed (`display.detailLabelPath`).
 */
export const financialAccountDetailFields = {
  "financial-account-identity": (account, queryClient) => ({
    value: renderOptionCell(
      account.identity.kind,
      fieldEnumOptions(queryClient, "financialAccount", "identity"),
    ),
    filterAction: (
      <EntityFilterLink
        to="/financial-accounts"
        search={{ identity: account.identity.kind }}
        label={`Show all ${account.identity.kind.replaceAll("_", " ")} accounts`}
      />
    ),
  }),
} satisfies EntityDetailFieldRenderers<"financialAccount">;
