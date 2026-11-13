import { imageBacklogContract } from "~/contracts/image-backlog.contract";
import { readDeviceBacklog } from "~/server/domains/image-processing/repo/device-backlog";
import { implementOperationDomain } from "~/server/operation-runtime/operation-domain.server";
export const imageBacklogHandlers = implementOperationDomain(
  imageBacklogContract,
  {
    deviceBacklog: (context) => readDeviceBacklog(context.db),
  },
);
