import type { ShortcodeEntity } from "./entity-manifest";
import {
  withEntityDetailMedia,
  withEntityListMedia,
} from "./entity-read-media";
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
) => ({
  entity,
  id: shortcodeSchema(entity),
  ...schemas,
  repositoryDetail: schemas.detail,
  repositoryList: schemas.list,
  detail: withEntityDetailMedia(schemas.detail),
  list: withEntityListMedia(schemas.list),
  mcpDetail: withEntityDetailMedia(schemas.mcpDetail),
  mcpList: withEntityListMedia(schemas.mcpList),
});
