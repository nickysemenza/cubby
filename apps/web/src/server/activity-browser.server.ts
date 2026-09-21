import { activityContract } from "~/contracts/activity.contract";
import { implementOperationDomain } from "~/server/operation-domain.server";
import {
  listActivity,
  activityDetail,
  activityEvents,
  activityDevices,
  activitySubmission,
} from "~/server/repo/activity";
export const activityHandlers = implementOperationDomain(activityContract, {
  list: async (context, input) =>
    listActivity(context.db, (await context.currentParty())?.id ?? null, input),
  detail: async (context, input) =>
    activityDetail(
      context.db,
      (await context.currentParty())?.id ?? null,
      input,
    ),
  events: async (context, input) =>
    activityEvents(
      context.db,
      (await context.currentParty())?.id ?? null,
      input,
    ),
  devices: async (context) =>
    activityDevices(context.db, (await context.currentParty())?.id ?? null),
  submission: async (context, input) =>
    activitySubmission(context.db, input.id),
});
