import { expect, it } from "vitest";

import { correctnessTokens, photoFieldCrossCheck } from "./photo-correctness";

// Retrieval intentionally drops these tokens; correctness must distinguish sizes and widths.
it("keeps short, numeric, decimal and fractional identity tokens", () => {
  expect(correctnessTokens("US 10½ D · 10.5 / M / 7 / XL")).toEqual([
    "us",
    "10½",
    "d",
    "10.5",
    "m",
    "7",
    "xl",
  ]);
  const marks = photoFieldCrossCheck(
    {
      name: "Synthetic boot US 10 D",
      manufacturer: "Forge",
      model: "X7",
      identifiers: ["ABC-100"],
    },
    ["Synthetic boot US 9 D Forge X7 ABC-100"],
    {
      color: { relation: "same" },
      size: { relation: "different" },
      evidence: { firstTitle: "", secondTitle: "" },
    },
  );
  expect(
    marks
      .find((field) => field.field === "name")
      ?.tokens.find((token) => token.text === "10")?.mark,
  ).toBe("disagree-or-missing");
  expect(marks.find((field) => field.field === "model")?.mark).toBe("agree");
  expect(marks.find((field) => field.field === "color")?.mark).toBe("unknown");
  expect(marks.find((field) => field.field === "size")?.mark).toBe(
    "disagree-or-missing",
  );
  expect(
    photoFieldCrossCheck(
      {
        name: "Synthetic boot",
        manufacturer: null,
        model: null,
        identifiers: [],
      },
      [],
    ).every((field) => field.mark === "unknown"),
  ).toBe(true);
});

// A shorter catalog name must not hide printed size and width tokens.
it("marks label size and width missing from the Product name", () => {
  const marks = photoFieldCrossCheck(
    {
      name: "Synthetic boot",
      manufacturer: "Forge",
      model: null,
      identifiers: [],
    },
    ["Forge Synthetic boot US 10 D"],
  );
  const name = marks.find((field) => field.field === "name");
  expect(name?.mark).toBe("disagree-or-missing");
  expect(name?.tokens).toEqual(
    expect.arrayContaining([
      { text: "10", mark: "disagree-or-missing" },
      { text: "d", mark: "disagree-or-missing" },
    ]),
  );
});

// Ordinary label prose and OCR fragments must not become Product-name corrections.
it("compares a shoe size and routes an unknown style code away from name noise", () => {
  const marks = photoFieldCrossCheck(
    { name: "Acme Men's Harbor Penny Loafer, Black, Size 9", identifiers: [] },
    ["MEN'S / 9M / C33223 / MADE IN VIETNAM / Bather and Manmade"],
  );
  expect(marks.find((field) => field.field === "size")).toMatchObject({
    source: "deterministic",
    mark: "agree",
    labelValue: "9M",
    productValue: "9",
    suggestion: null,
  });
  expect(marks.find((field) => field.field === "name")?.mark).not.toBe(
    "disagree-or-missing",
  );
  expect(marks.find((field) => field.field === "identifiers")).toMatchObject({
    mark: "disagree-or-missing",
    labelValue: "C33223",
    productValue: null,
    suggestion: { kind: "set_model", value: "C33223" },
  });
  expect(
    marks.filter((field) => field.suggestion?.kind === "add_to_name"),
  ).toEqual([]);
});

it("keeps absent catalog colours unknown and ignores repeated label boilerplate", () => {
  const marks = photoFieldCrossCheck(
    {
      name: "Acme Gazelle Indoor — Beige/White",
      manufacturer: "Acme",
      model: "HQ5154",
      identifiers: [],
    },
    [
      "acme",
      "acme",
      "ath laster",
      "GAZELLE INDOOR",
      "ORIGINALS",
      "ORIGINALS",
      "HQ5154",
      "MALE",
    ],
  );
  expect(marks.find((field) => field.field === "manufacturer")?.mark).toBe(
    "agree",
  );
  expect(marks.find((field) => field.field === "model")?.mark).toBe("agree");
  expect(marks.find((field) => field.field === "name")?.tokens).toEqual([
    { text: "acme", mark: "agree" },
    { text: "gazelle", mark: "agree" },
    { text: "indoor", mark: "agree" },
    { text: "beige/white", mark: "unknown" },
  ]);
  expect(
    marks.filter((field) => field.suggestion?.kind === "add_to_name"),
  ).toEqual([]);
});

it.each([
  "US 9",
  "EU 42",
  "UK 8",
  "9M",
  "10.5",
  "10½",
  "XS",
  "XXL",
  "W",
  "D",
  "32x30",
  "Blue",
])("suggests only the printed missing variant term %s", (printed) => {
  const marks = photoFieldCrossCheck({ name: "Acme Harbor", identifiers: [] }, [
    `Acme Harbor / ${printed} / ${printed} / originals authentic style art color / leather manmade synthetic textile cotton / men's women's male female unisex / and the of in / ath laster`,
  ]);
  const name = marks.find((field) => field.field === "name");
  expect(name).toMatchObject({
    mark: "disagree-or-missing",
    suggestion: { kind: "add_to_name", value: printed },
  });
  expect(
    name?.tokens.filter((token) => token.mark === "disagree-or-missing"),
  ).toHaveLength(1);
});

it("reports an explicit size contradiction without suggesting another size in the name", () => {
  const marks = photoFieldCrossCheck(
    { name: "Acme Harbor Size 9", identifiers: [] },
    ["Acme Harbor / Size 10"],
  );
  expect(marks.find((field) => field.field === "size")).toMatchObject({
    source: "deterministic",
    mark: "disagree-or-missing",
    labelValue: "Size 10",
    productValue: "9",
    suggestion: null,
  });
  expect(marks.find((field) => field.field === "name")?.suggestion).toBeNull();
});

it.each(["9M", "9 M", "US 9", "Size 9"])(
  "normalizes %s to the catalog size",
  (printed) => {
    const marks = photoFieldCrossCheck(
      { name: "Acme Harbor, Size 9", identifiers: [] },
      [printed, printed.toLowerCase()],
    );
    expect(marks.find((field) => field.field === "size")).toMatchObject({
      mark: "agree",
      labelValue: printed,
      productValue: "9",
      suggestion: null,
    });
    expect(marks.find((field) => field.field === "name")?.mark).not.toBe(
      "disagree-or-missing",
    );
  },
);

it("compares fractional sizes and punctuation-insensitive identifiers without duplicate warnings", () => {
  const marks = photoFieldCrossCheck(
    {
      name: "Acme Harbor US 10.5 D",
      model: "ZQ-2468",
      identifiers: ["AB-7654"],
    },
    ["ACME HARBOR / 10½ D / ZQ2468 / AB7654", "10½ D"],
  );
  expect(marks.find((field) => field.field === "size")?.mark).toBe("agree");
  expect(marks.find((field) => field.field === "model")?.mark).toBe("agree");
  expect(marks.find((field) => field.field === "identifiers")?.mark).toBe(
    "agree",
  );
  expect(marks.filter((field) => field.suggestion)).toEqual([]);
});

it("adds a missing code as an identifier when the Product already has a model", () => {
  const marks = photoFieldCrossCheck(
    { name: "Acme Harbor", model: "ZQ-2468", identifiers: [] },
    ["ZQ2468 / AB7654 / AB7654"],
  );
  expect(marks.find((field) => field.field === "identifiers")).toMatchObject({
    labelValue: "AB7654",
    suggestion: { kind: "add_identifier", value: "AB7654" },
  });
});

it("keeps model-only agreement unknown and model-only differences unverified", () => {
  const marks = photoFieldCrossCheck(
    { name: "Acme Harbor Size 9 Blue", identifiers: [] },
    [],
    {
      color: { relation: "same" },
      size: { relation: "different" },
      evidence: { firstTitle: "", secondTitle: "" },
    },
  );
  expect(marks.find((field) => field.field === "color")).toMatchObject({
    source: "model",
    mark: "unknown",
    labelValue: null,
    suggestion: null,
  });
  expect(marks.find((field) => field.field === "size")).toMatchObject({
    source: "model",
    mark: "disagree-or-missing",
    labelValue: null,
    suggestion: null,
  });
  expect(
    marks.filter((field) => field.source === "model" && field.mark === "agree"),
  ).toEqual([]);
});

it("treats a hyphenated style code as an identifier rather than a numeric size", () => {
  const marks = photoFieldCrossCheck({ name: "Acme Harbor", identifiers: [] }, [
    "AB-123 / 100% cotton / MADE IN NEW ZEALAND",
  ]);
  expect(marks.find((field) => field.field === "identifiers")).toMatchObject({
    labelValue: "AB-123",
    suggestion: { kind: "set_model", value: "AB-123" },
  });
  expect(marks.find((field) => field.field === "size")?.mark).toBe("unknown");
  expect(marks.find((field) => field.field === "name")?.mark).toBe("unknown");
});

it("ignores sentence punctuation around an otherwise equal size", () => {
  const marks = photoFieldCrossCheck(
    { name: "Acme Harbor Size 9.", identifiers: [] },
    ["US 9."],
  );
  expect(marks.find((field) => field.field === "size")).toMatchObject({
    source: "deterministic",
    mark: "agree",
    productValue: "9",
  });
});

it("matches punctuation-separated name and manufacturer words in either direction", () => {
  const marks = photoFieldCrossCheck(
    { name: "Acme Harbor-Indoor", manufacturer: "Acme Works", identifiers: [] },
    ["ACME-WORKS / HARBOR INDOOR"],
  );
  expect(marks.find((field) => field.field === "manufacturer")).toMatchObject({
    mark: "agree",
    labelValue: "acme-works",
    productValue: "Acme Works",
  });
  expect(marks.find((field) => field.field === "name")?.mark).toBe("agree");
});

it("does not compare possessive gender suffixes as apparel sizes", () => {
  const marks = photoFieldCrossCheck(
    { name: "Acme Men's Shirt Size M", identifiers: [] },
    ["MEN’S / M / 100% COTTON"],
  );
  expect(marks.find((field) => field.field === "size")?.mark).toBe("agree");
  expect(marks.find((field) => field.field === "name")?.mark).not.toBe(
    "disagree-or-missing",
  );
});

it("ignores provenance on its line without swallowing a colour on the next OCR line", () => {
  const marks = photoFieldCrossCheck({ name: "Acme Harbor", identifiers: [] }, [
    "MADE IN IVORY COAST",
    "BLUE",
    "BLUE",
  ]);
  expect(marks.find((field) => field.field === "color")).toMatchObject({
    labelValue: "BLUE",
    suggestion: { kind: "add_to_name", value: "BLUE" },
  });
});
