import {
  chatGptAuthorization,
  chatGptAuthorizationHost,
  chatGptStatus,
} from "@cubby/schemas/chatgpt";
import { z } from "zod";

import { defineContract, query, mutation } from "~/contracts/define";

export const chatgptContract = defineContract("chatgpt", {
  authorizationHost: query({
    native: "Shared ChatGPT plan sign-in from CubbyKit",
    input: z.undefined(),
    output: chatGptAuthorizationHost,
    cache: { profile: "live-status" },
  }),
  connect: mutation({
    native: "Shared ChatGPT plan sign-in from CubbyKit",
    input: chatGptAuthorization,
    output: chatGptStatus,
  }),
});
