import { z } from "zod";
import { ledgerPartyShortcode } from "./identifiers";

export {
  ledgerAttributions,
  ledgerPartyKind,
  type LedgerAttributionInput,
  type LedgerPartyKind,
} from "./ledger-party-fields";
import { ledgerPartyKind } from "./ledger-party-fields";

export { contributionRole, type ContributionRole } from "./ledger-party-fields";

const ledgerPartyOptionsOut = z.array(
  z.object({
    id: ledgerPartyShortcode,
    name: z.string(),
    kind: ledgerPartyKind,
  }),
);
export type LedgerPartyOptionsOut = z.infer<typeof ledgerPartyOptionsOut>;
