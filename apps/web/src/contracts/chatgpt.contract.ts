import {
  chatGptAuthorization,
  chatGptAuthorizationHost,
  chatGptStatus,
} from "@cubby/schemas/chatgpt";
import { z } from "zod";

import { defineContract, query, mutation } from "~/contracts/define";

export const chatgptContract = defineContract(
  "chatgpt",
  {
    authorizationHost: query({
      input: z.undefined(),
      output: chatGptAuthorizationHost,
      cache: { profile: "live-status" },
    }),
    connect: mutation({
      input: chatGptAuthorization,
      output: chatGptStatus,
    }),
  },
  { exposure: "view" },
);
