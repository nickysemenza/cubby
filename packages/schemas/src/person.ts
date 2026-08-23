import { z } from "zod";
import {
  auditDateFilterFields,
  deriveUpdateData,
  timestampedFields,
} from "./base-entity";
import { requiredName } from "./common";
import { personShortcode } from "./identifiers";
import {
  createPaginatedResponseSchema,
  oneOrMany,
  presenceFilter,
} from "./pagination";

export const personKindValues = ["household", "guest"] as const;
export const personKindSchema = z.enum(personKindValues);
export type PersonKind = z.infer<typeof personKindSchema>;

const personFields = {
  name: z.string(),
  kind: personKindSchema,
  notes: z.string().nullable(),
};

const personCreateShape = {
  name: requiredName("Person name"),
  kind: personKindSchema,
  notes: z.string().nullable().default(null),
};

export const personCreateInput = z.object(personCreateShape);
export type PersonCreateInput = z.infer<typeof personCreateInput>;

export const personUpdateData = deriveUpdateData(personCreateShape);
export type PersonUpdateData = z.infer<typeof personUpdateData>;

export const personUpdateInput = z.object({
  id: personShortcode,
  data: personUpdateData,
});
export type PersonUpdateInput = z.infer<typeof personUpdateInput>;

export const personFilterFields = {
  ...auditDateFilterFields,
  search: z.string().optional(),
  kind: oneOrMany(personKindSchema).optional(),
  linkedUserPresenceFilter: presenceFilter,
};
export const personFiltersSchema = z.object(personFilterFields);
export type PersonFilters = z.infer<typeof personFiltersSchema>;

export const personSortableFields = [
  "name",
  "kind",
  "createdAt",
  "updatedAt",
] as const;
export type PersonSortField = (typeof personSortableFields)[number];

export const personOut = z.object({
  id: personShortcode,
  ...personFields,
  linkedUser: z
    .object({
      name: z.string(),
      email: z.email(),
    })
    .nullable(),
  ...timestampedFields,
});
export type PersonOut = z.infer<typeof personOut>;

export const personListResponse = createPaginatedResponseSchema(personOut);
export type PersonListResponse = z.infer<typeof personListResponse>;

export const personOptionsOut = z.array(
  z.object({
    id: personShortcode,
    name: z.string(),
    kind: personKindSchema,
  }),
);
export type PersonOptionsOut = z.infer<typeof personOptionsOut>;

export const linkCurrentUserToPersonInput = z.object({
  id: personShortcode,
});
export type LinkCurrentUserToPersonInput = z.infer<
  typeof linkCurrentUserToPersonInput
>;

export const unlinkPersonUserInput = z.object({ id: personShortcode });
export type UnlinkPersonUserInput = z.infer<typeof unlinkPersonUserInput>;

export const mergePeopleInput = z.object({
  keepId: personShortcode,
  mergeIds: z.array(personShortcode).min(1),
});
export type MergePeopleInput = z.infer<typeof mergePeopleInput>;

export const personMergeSummaryOut = z.object({
  keepId: personShortcode,
  deletedIds: z.array(personShortcode),
  merged: z.number().int().nonnegative(),
  beneficiaryEdgesRepointed: z.number().int().nonnegative(),
  fundingEdgesRepointed: z.number().int().nonnegative(),
  accountEdgesRepointed: z.number().int().nonnegative(),
  transferEdgesRepointed: z.number().int().nonnegative(),
  carriedFields: z.array(z.string()),
});
export type PersonMergeSummaryOut = z.infer<typeof personMergeSummaryOut>;

export const mergePeopleOut = z.object({
  person: personOut,
  mergeSummary: personMergeSummaryOut,
});
export type MergePeopleOut = z.infer<typeof mergePeopleOut>;
