import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import device from "./entity-definitions/24-device.entity";
import { fieldSchemasOf } from "./entity-definitions/definition";
import { generatedDeviceFieldSchemas } from "./generated/entity-field-schemas.device.gen";

// An annotation must retain exact Zod classes, brands, optionality, and
// input/output types; merely assigning to ZodType would erase object methods.
const original = fieldSchemasOf(device);
expectTypeOf(generatedDeviceFieldSchemas.create).toEqualTypeOf(original.create);
expectTypeOf(generatedDeviceFieldSchemas.update).toEqualTypeOf(original.update);
const { dataQuality: _dataQuality, ...generatedRead } =
  generatedDeviceFieldSchemas.read;
expectTypeOf(generatedRead).toEqualTypeOf(original.read);
const create = z.object(generatedDeviceFieldSchemas.create);
const update = z.object(generatedDeviceFieldSchemas.update);
expectTypeOf<z.input<typeof create>>().toEqualTypeOf<
  z.input<ReturnType<typeof originalCreate>>
>();
expectTypeOf<z.output<typeof create>>().toEqualTypeOf<
  z.output<ReturnType<typeof originalCreate>>
>();
expectTypeOf<z.input<typeof create>["automaticWork"]>().toEqualTypeOf<
  boolean | undefined
>();
expectTypeOf<
  z.output<typeof create>["automaticWork"]
>().toEqualTypeOf<boolean>();
function originalCreate() {
  return z.object(original.create);
}

// No casts/suppressions: a raw string must not be assignable to an output ID.
type AssertFalse<T extends false> = T;
export type BrandPreserved = AssertFalse<
  string extends z.output<typeof generatedRead.id> ? true : false
>;
export type InputIsNotOutput = AssertFalse<
  z.input<typeof create> extends z.output<typeof create> ? true : false
>;
export type NoUndeclaredKeys = AssertFalse<
  "syntheticUnknownField" extends keyof typeof generatedDeviceFieldSchemas.create
    ? true
    : false
>;

describe("generated schema contract annotations", () => {
  it("preserves schema identity and object composition", () => {
    expect(generatedDeviceFieldSchemas.create.name).toBe(original.create.name);
    expect(generatedDeviceFieldSchemas.update.name).toBe(original.update.name);
    expect(generatedRead).toEqual(original.read);
    expect(
      create.pick({ name: true }).parse({ name: "  synthetic  " }),
    ).toEqual({ name: "synthetic" });
    expect(update.partial().parse({})).toEqual({});
    expect(create.pick({ automaticWork: true }).parse({})).toEqual({
      automaticWork: true,
    });
    expect(
      generatedDeviceFieldSchemas.create.platform
        .exclude(["ios"])
        .safeParse("ios").success,
    ).toBe(false);
  });
});
