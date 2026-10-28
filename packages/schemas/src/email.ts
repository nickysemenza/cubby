import { z } from "zod";

import { emailLinkState } from "./email-fields";
import {
  purchaseShortcode,
  vendorAccountShortcode,
  vendorShortcode,
} from "./identifiers";
import { oneOrMany, oneOrManyValues } from "./pagination";
import { emailFilterFields as emailBaseFilterFields } from "@cubby/schemas/entities/email";

/** A scope filter's declared `singleValue`: one record, as a scalar or a one-element list. */
const oneScopeValue = <T extends z.ZodTypeAny>(code: T) =>
  oneOrMany(code).refine(
    (value) => (oneOrManyValues(value)?.length ?? 0) <= 1,
    "Scope an Email list by one record.",
  );

/**
 * The derived Emails-section scopes (ADR 0011): Emails related to a Purchase
 * by accepted import evidence, reviewed decisions or a live suggestion; a
 * Vendor's also include its sender-proof mail; an account's are its Vendor's
 * owned by the account's member. `linkState` narrows by the scope-relative
 * state the list shows.
 */
export const emailFilterFields = {
  ...emailBaseFilterFields,
  purchaseId: oneScopeValue(purchaseShortcode).optional(),
  vendorId: oneScopeValue(vendorShortcode).optional(),
  vendorAccountId: oneScopeValue(vendorAccountShortcode).optional(),
  linkState: oneOrMany(emailLinkState).optional(),
};
export const emailFiltersSchema = z.object(emailFilterFields);
export type EmailFilters = z.infer<typeof emailFiltersSchema>;
