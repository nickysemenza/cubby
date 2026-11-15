import { devicePushContract } from "~/contracts/device-push.contract";
import {
  registerDevicePush,
  endDevicePush,
  testDevicePush,
} from "~/server/domains/device/repo/device-push";
import { implementOperationDomain } from "~/server/operation-runtime/operation-domain.server";
export const devicePushHandlers = implementOperationDomain(devicePushContract, {
  register: (context, input) =>
    registerDevicePush(
      context.db,
      context.actorContext,
      context.auth.sessionId,
      input,
    ),
  end: (context) => endDevicePush(context.db, context.actorContext),
  test: (context, input) => testDevicePush(context.db, input.deviceId),
});
