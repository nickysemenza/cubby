import { z } from "zod";

import { emailLinkState } from "./email-fields";
import {
  purchaseShortcode,
  vendorAccountShortcode,
  vendorShortcode,
} from "./identifiers";
import { oneOrMany } from "./pagination";
import { emailBaseFilterFields } from "./generated/email.gen";

export { emailOut, type EmailOut } from "./generated/email.gen";

/**
 * The derived Emails-section scopes (ADR 0011): Emails related to a Purchase
 * by accepted import evidence, reviewed decisions or a live suggestion; a
 * Vendor's also include its sender-proof mail; an account's are its Vendor's
 * owned by the account's member. `linkState` narrows by the scope-relative
 * state the list shows.
 */
export const emailFilterFields = {
  ...emailBaseFilterFields,
  purchaseId: purchaseShortcode.optional(),
  vendorId: vendorShortcode.optional(),
  vendorAccountId: vendorAccountShortcode.optional(),
  linkState: oneOrMany(emailLinkState).optional(),
};
export const emailFilters = z.object(emailFilterFields);
export type EmailFilters = z.infer<typeof emailFilters>;
