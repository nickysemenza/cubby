CREATE TABLE "KernelWake" (
	"singleton" boolean PRIMARY KEY DEFAULT true,
	"at" timestamp(3),
	CONSTRAINT "KernelWake_singleton_check" CHECK ("singleton")
);
