import definition from "./entity-definitions/07-ledgerParty.entity";
import type { z } from "zod";

/** Repository/compiler reads; public entities use generated field envelopes. */
export const rawLedgerPartyOut = definition.readSchemas.output;
export type RawLedgerPartyOut = z.output<typeof rawLedgerPartyOut>;
