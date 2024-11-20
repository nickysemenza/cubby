import { FetchInstrumentation, registerOTel } from "@vercel/otel";
import { PrismaInstrumentation } from "@prisma/instrumentation";

export function register() {
  console.log("foo");
  registerOTel({
    serviceName: "next-app",
    instrumentations: [new PrismaInstrumentation(), new FetchInstrumentation()],
  });
}
