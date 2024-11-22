declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace PrismaJson {
    type Amount = { unit: string; value: number };
    type Instruction = { text: string };
  }
}
