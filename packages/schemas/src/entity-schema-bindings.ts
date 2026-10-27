import type { ShortcodeEntity } from "./entity-manifest";
import { shortcodeSchema } from "./identifier-fields";
import type { z } from "zod";

export const entitySchema = <
  const E extends ShortcodeEntity,
  SFilters extends z.ZodType,
  SCreate extends z.ZodType | null,
  SUpdate extends z.ZodType | null,
  SBulkUpdate extends z.ZodType | null,
  SOutput extends z.ZodType,
  SDetail extends z.ZodType,
  SList extends z.ZodType,
  SMcpOutput extends z.ZodType,
  SMcpDetail extends z.ZodType,
  SMcpList extends z.ZodType,
  Public extends Readonly<{
    output: z.ZodType;
    detail: z.ZodType;
    list: z.ZodType;
    mcpOutput: z.ZodType;
    mcpDetail: z.ZodType;
    mcpList: z.ZodType;
  }>,
>(
  entity: E,
  schemas: {
    filters: SFilters;
    createInput: SCreate;
    updateInput: SUpdate;
    bulkUpdateInput: SBulkUpdate;
    output: SOutput;
    detail: SDetail;
    list: SList;
    mcpOutput: SMcpOutput;
    mcpDetail: SMcpDetail;
    mcpList: SMcpList;
  },
  publicReads: Public,
) => ({
  entity,
  id: shortcodeSchema(entity),
  ...schemas,
  ...publicReads,
  repositoryOutput: schemas.output,
  repositoryDetail: schemas.detail,
  repositoryList: schemas.list,
});
