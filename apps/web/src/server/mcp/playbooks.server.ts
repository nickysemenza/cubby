import { playbookContract } from "~/contracts/playbook.contract";
import { implementOperationDomain } from "~/server/operation-runtime/operation-domain.server";

import { getPlaybook, listPlaybooks, readPlaybookFile } from "./playbooks";

export const playbookHandlers = implementOperationDomain(playbookContract, {
  list: async () => ({ playbooks: listPlaybooks() }),
  get: async (_context, input) => getPlaybook(input.name),
  read: async (_context, input) => readPlaybookFile(input.path, input.heading),
});
