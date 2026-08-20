import {
  type financialAccountIdentity,
  financialAccountIdentityKind,
} from "@cubby/schemas/financial-account";
import { useMemo } from "react";
import type { UseFormReturn } from "react-hook-form";
import { z } from "zod";
import { NullableTextareaField } from "~/app/_components/form-utils";
import { QuickAddDialog } from "~/app/_components/forms/quick-add-dialog";
import { useTRPC } from "~/integrations/trpc/react";
import { financialAccountMutationInvalidateKeys } from "~/lib/query-keys";
import {
  SelectField,
  SourceAliasesField,
  TextField,
} from "./financial-form-fields";

const formSchema = z.object({
  name: z.string().min(1),
  kind: financialAccountIdentityKind,
  issuer: z.string(),
  network: z.enum(["", "visa", "mastercard", "amex", "discover", "other"]),
  institution: z.string(),
  accountType: z.enum(["checking", "savings", "money_market", "other"]),
  provider: z.string(),
  last4: z.string(),
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
export function CreateFinancialAccountDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const api = useTRPC();
  const defaults = useMemo<z.infer<typeof formSchema>>(
    () => ({
      name: "",
      kind: "credit_card" as const,
      issuer: "",
      network: "",
      institution: "",
      accountType: "checking" as const,
      provider: "",
      last4: "",
      provisional: false,
      sourceAliases: [],
      notes: "",
    }),
    [],
  );
  return (
    <QuickAddDialog
      entity="financialAccount"
      open={open}
      onOpenChange={onOpenChange}
      schema={formSchema}
      defaultValues={defaults}
      title="New Account"
      description="A settlement account, not a source of spend. Use its source aliases as evidence from statements and receipts."
      mutationFn={api.financialAccount.create.mutationOptions}
      successMessage="Account created"
      invalidateKeys={financialAccountMutationInvalidateKeys}
      buildPayload={(v) => ({
        name: v.name.trim(),
        provisional: v.provisional,
        identity: identity(v),
        sourceAliases: v.sourceAliases
          .filter((a) => a.source.trim() && a.alias.trim())
          .map((a) => ({
            ...a,
            externalAccountId: a.externalAccountId || null,
          })),
        notes: v.notes.trim() || null,
      })}
    >
      {(form) => (
        <>
          <TextField form={form} name="name" label="Name" />
          <SelectField
            form={form}
            name="kind"
            label="Identity kind"
            values={[
              "credit_card",
              "bank_account",
              "stored_value",
              "cash",
              "other",
            ]}
          />
          <IdentityFields form={form} />
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
function IdentityFields({
  form,
}: {
  form: UseFormReturn<z.infer<typeof formSchema>>;
}) {
  const kind = form.watch("kind");
  return (
    <>
      {kind === "credit_card" && (
        <>
          <TextField form={form} name="issuer" label="Issuer" />
          <SelectField
            form={form}
            name="network"
            label="Network"
            values={["visa", "mastercard", "amex", "discover", "other"]}
          />
        </>
      )}
      {kind === "bank_account" && (
        <>
          <TextField form={form} name="institution" label="Institution" />
          <SelectField
            form={form}
            name="accountType"
            label="Account type"
            values={["checking", "savings", "money_market", "other"]}
          />
        </>
      )}
      {kind === "stored_value" && (
        <TextField form={form} name="provider" label="Provider" />
      )}
      {kind === "other" && (
        <TextField form={form} name="institution" label="Institution" />
      )}
      {kind !== "cash" && (
        <TextField form={form} name="last4" label="Last four" />
      )}
    </>
  );
}
function identity(
  v: z.infer<typeof formSchema>,
): z.infer<typeof financialAccountIdentity> {
  const last4 = v.last4.trim() || null;
  if (v.kind === "credit_card")
    return {
      kind: v.kind,
      issuer: v.issuer.trim() || null,
      network: v.network || null,
      last4,
    };
  if (v.kind === "bank_account")
    return {
      kind: v.kind,
      institution: v.institution.trim() || null,
      accountType: v.accountType,
      last4,
    };
  if (v.kind === "stored_value")
    return { kind: v.kind, provider: v.provider.trim(), last4 };
  if (v.kind === "other")
    return { kind: v.kind, institution: v.institution.trim() || null, last4 };
  return { kind: "cash" as const };
}
