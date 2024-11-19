declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace PrismaJson {
    type MyType = boolean;
    type Amount = { unit?: string; quantity: number };
  }
}
