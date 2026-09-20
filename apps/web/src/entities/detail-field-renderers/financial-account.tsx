import { renderOptionCell } from "~/app/_components/data-table/columnHelpers";
import { accountIdentityKindOptions } from "~/app/finance/financial-account-options";
import { EntityFilterLink } from "~/components/ui/entity-filter-link";
import { NoneValue } from "~/components/ui/none-value";

import type { EntityDetailFieldRenderers } from "./index";

export const financialAccountDetailFields = {
  "financial-account-identity": (account) => ({
    value: renderOptionCell(account.identity.kind, accountIdentityKindOptions),
    filterAction: (
      <EntityFilterLink
        to="/financial-accounts"
        search={{ identity: account.identity.kind }}
        label={`Show all ${account.identity.kind.replaceAll("_", " ")} accounts`}
      />
    ),
  }),
  "financial-account-source-aliases": (account) => ({
    value:
      account.sourceAliases.length > 0 ? (
        <span className="font-mono text-xs">
          {account.sourceAliases
            .map((alias) => `${alias.source}: ${alias.alias}`)
            .join(", ")}
        </span>
      ) : (
        <NoneValue />
      ),
  }),
} satisfies EntityDetailFieldRenderers<"financialAccount">;
