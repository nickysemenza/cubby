import definition from "./entity-definitions/08-ledgerTransfer.entity";
import type { z } from "zod";

/** Repository/compiler reads; public entities use generated field envelopes. */
export const rawLedgerTransferOut = definition.readSchemas.output;
export type RawLedgerTransferOut = z.output<typeof rawLedgerTransferOut>;
