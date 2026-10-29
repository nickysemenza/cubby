export type ToolName<T> = keyof T & string;
export type ToolActionName<
  T,
  Tool extends keyof T,
> = T[Tool] extends readonly string[] ? T[Tool][number] : never;
export type ToolAction<T> = {
  [Tool in ToolName<T>]: `${Tool}.${ToolActionName<T, Tool>}`;
}[ToolName<T>];
export type TupleMember<T extends readonly string[]> = T[number];
