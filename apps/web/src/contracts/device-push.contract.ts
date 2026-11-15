import {
  devicePushRegisterInput,
  devicePushRegisterOutput,
} from "@cubby/schemas/device-fields";
import { deviceShortcode } from "@cubby/schemas/identifiers";
import { z } from "zod";

import { defineContract, mutation } from "~/contracts/define";

export const devicePushContract = defineContract(
  "devicePush",
  {
    register: mutation({
      input: devicePushRegisterInput,
      output: devicePushRegisterOutput,
    }),
    end: mutation({ input: z.null(), output: devicePushRegisterOutput }),
    test: mutation({
      input: z.object({ deviceId: deviceShortcode }),
      output: z.object({ accepted: z.boolean(), error: z.string().nullable() }),
      command: { label: "Send test notification", confirmation: null },
    }),
  },
  { exposure: "view" },
);
