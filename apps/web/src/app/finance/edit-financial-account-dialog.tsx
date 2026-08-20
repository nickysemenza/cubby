import type { FinancialAccountOut } from "@cubby/schemas/financial-account";
import { useMemo } from "react";
import { z } from "zod";
import { NullableTextareaField } from "~/app/_components/form-utils";
import { QuickAddDialog } from "~/app/_components/forms/quick-add-dialog";
import { useTRPC } from "~/integrations/trpc/react";
import { financialAccountMutationInvalidateKeys } from "~/lib/query-keys";
import { SourceAliasesField, TextField } from "./financial-form-fields";

const formSchema = z.object({
  name: z.string().min(1),
  provisional: z.boolean(),
  sourceAliases: z.array(
    z.object({
      source: z.string(),
      alias: z.string(),
      externalAccountId: z.string().nullable(),
    }),
  ),
  notes: z.string(),
});
/** Identity is structured and complete; this dialog intentionally edits aliases
 * as rows rather than serializing unreviewable JSON. Identity-kind changes stay
 * a deliberate MCP/read–merge–write operation until a dedicated converter exists. */
export function EditFinancialAccountDialog({
  account,
  open,
  onOpenChange,
}: {
  account: FinancialAccountOut;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const api = useTRPC();
  const defaults = useMemo(
    () => ({
      name: account.name,
      provisional: account.provisional,
      sourceAliases: account.sourceAliases,
      notes: account.notes ?? "",
    }),
    [account],
  );
  return (
    <QuickAddDialog
      entity="financialAccount"
      operation="update"
      intent="full"
      open={open}
      onOpenChange={onOpenChange}
      schema={formSchema}
      defaultValues={defaults}
      title="Edit Account"
      description="Aliases replace the complete evidence list. Keep every source row you still need."
      mutationFn={api.financialAccount.update.mutationOptions}
      successMessage="Account updated"
      invalidateKeys={financialAccountMutationInvalidateKeys}
      buildPayload={(v) => ({
        id: account.id,
        data: {
          name: v.name.trim(),
          provisional: v.provisional,
          sourceAliases: v.sourceAliases
            .filter((a) => a.source.trim() && a.alias.trim())
            .map((a) => ({
              ...a,
              externalAccountId: a.externalAccountId || null,
            })),
          notes: v.notes.trim() || null,
        },
      })}
    >
      {(form) => (
        <>
          <TextField form={form} name="name" label="Name" />
          <SourceAliasesField form={form} />
          <NullableTextareaField
            form={form}
            name="notes"
            label="Notes"
            placeholder="Optional evidence"
          />
        </>
      )}
    </QuickAddDialog>
  );
}
