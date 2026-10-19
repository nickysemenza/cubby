import { z } from "zod";

import { defineContract, query } from "~/contracts/define";

const playbookOut = z.object({
  name: z.string(),
  description: z.string(),
  path: z.string(),
  files: z.array(z.string()),
});

export const playbookContract = defineContract("playbook", {
  list: query({
    input: z.undefined(),
    output: z.object({ playbooks: z.array(playbookOut) }),
  }),
  get: query({
    input: z.strictObject({ name: z.string().min(1) }),
    output: playbookOut.extend({ content: z.string() }),
  }),
  read: query({
    input: z.strictObject({
      path: z.string().min(1),
      heading: z.string().min(1).optional(),
    }),
    output: z.object({
      path: z.string(),
      heading: z.string().nullable(),
      content: z.string().nullable(),
      outline: z.array(z.string()).nullable(),
    }),
  }),
});
