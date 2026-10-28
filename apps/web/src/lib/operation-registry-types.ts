import type { WorkflowCommandMetadata } from "@cubby/schemas/workflow-command";

export type RegistryKeys<T> = keyof T;
export type RegisteredKind<
  T extends Record<string, { kind: string }>,
  Id extends keyof T,
> = T[Id]["kind"];
export type RegistryIdOfKind<
  T extends Record<string, { kind: string }>,
  Kind,
> = {
  [Id in keyof T]: RegisteredKind<T, Id> extends Kind ? Id : never;
}[keyof T];
export type OperationRegistry = Readonly<
  Record<
    string,
    {
      kind: "query" | "mutation" | "subscription";
      exposure?: "capability" | "view" | "internal";
      entities?: readonly string[];
      productPhases?: readonly string[];
      command?: WorkflowCommandMetadata;
      clientDomain?: string;
    }
  >
>;
