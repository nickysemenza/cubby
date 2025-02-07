import { FetchInstrumentation, registerOTel } from "@vercel/otel";
import { PrismaInstrumentation } from "@prisma/instrumentation";

export function register() {
  registerOTel({
    serviceName: "recipehub",
    instrumentations: [new PrismaInstrumentation(), new FetchInstrumentation()],
  });
}
