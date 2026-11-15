import { useMutation } from "@tanstack/react-query";

import type { DetailSlotComponent } from "~/entity/entity-detail/detail-slots";
import { devicePush } from "~/integrations/tanstack-query/generated/domains/devicePush.gen";
import { Button } from "~/ui/primitives/button";

export const DeviceNotifications: DetailSlotComponent<"device"> = ({
  record,
}) => {
  const test = useMutation(devicePush.test.mutationOptions());
  return (
    <div className="grid gap-2">
      <p>
        {record.pushRegistered
          ? "Registered for notifications."
          : "Enable notifications in the Cubby app on this device."}
      </p>
      <Button
        variant="outline"
        disabled={!record.pushRegistered || test.isPending}
        onClick={() => test.mutate({ deviceId: record.id })}
      >
        {test.isPending ? "Sending…" : "Send test notification"}
      </Button>
      {test.data && (
        <output>
          {test.data.accepted
            ? "Accepted by APNs. Check the device for delivery."
            : test.data.error}
        </output>
      )}
      {test.error && <p role="alert">{test.error.message}</p>}
      {!test.data && record.pushLastError && (
        <output>{record.pushLastError}</output>
      )}
    </div>
  );
};
