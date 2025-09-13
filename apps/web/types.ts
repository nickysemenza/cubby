export {};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace PrismaJson {
    export type Amount = { unit: string; value: number };
    export type Instruction = { text: string };
  }
}
