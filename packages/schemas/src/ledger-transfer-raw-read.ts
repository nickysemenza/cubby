import { readSchemas as definitionSchemas } from "./entity-definitions/08-ledgerTransfer.entity";
import type { z } from "zod";

/** Repository/compiler reads; public entities use generated field envelopes. */
export const rawLedgerTransferOut = definitionSchemas.output;
export type RawLedgerTransferOut = z.output<typeof rawLedgerTransferOut>;
