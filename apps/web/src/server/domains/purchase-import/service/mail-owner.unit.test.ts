import { describe, expect, it } from "vitest";

import {
  type MailOwnerEvidence,
  normalizeMailAddress,
  ownMailAttribution,
} from "./mail-owner";

const evidence: MailOwnerEvidence = {
  owner: {
    name: "Sam Example",
    addresses: ["Sam.Example@gmail.com", "sam@home.example.test"],
  },
  householdMembers: [
    { name: "Alex Example", addresses: ["alex@home.example.test"] },
  ],
};

const mail = (
  headers: Record<string, string>,
  overrides: { subject?: string; bodyText?: string } = {},
) => ({
  sender: headers.from ?? null,
  subject: overrides.subject ?? "Your order SYN-100 has shipped",
  content: {
    headers,
    bodyText: overrides.bodyText ?? "Order SYN-100: synthetic kettle $24.00",
    bodyHtml: null,
    snippet: null,
  },
});

const vendorToOwner = {
  from: "Kettle Shop <orders@kettle.example>",
  to: "samexample+orders@googlemail.com",
  "delivered-to": "samexample@gmail.com",
};

describe("normalizeMailAddress", () => {
  it("folds Gmail dots, +tags and googlemail.com", () => {
    expect(normalizeMailAddress(" Sam.Example+Shop@GoogleMail.com ")).toBe(
      "samexample@gmail.com",
    );
  });

  it("keeps dots outside Gmail but drops +tags", () => {
    expect(normalizeMailAddress("Sam.Example+shop@Home.Example.test")).toBe(
      "sam.example@home.example.test",
    );
  });

  it("rejects text without a mailbox", () => {
    expect(normalizeMailAddress("undisclosed-recipients")).toBeNull();
  });
});

describe("ownMailAttribution", () => {
  it("attributes a vendor's mail to the owner's own address", () => {
    expect(ownMailAttribution(mail(vendorToOwner), evidence)).toBe("recipient");
  });

  it("leaves a forwarding header to the model", () => {
    expect(
      ownMailAttribution(
        mail({ ...vendorToOwner, "x-forwarded-to": "samexample@gmail.com" }),
        evidence,
      ),
    ).toBeNull();
  });

  it("leaves a Fwd: subject or forwarded body to the model", () => {
    expect(
      ownMailAttribution(
        mail(vendorToOwner, { subject: "Fwd: Your order SYN-100" }),
        evidence,
      ),
    ).toBeNull();
    expect(
      ownMailAttribution(
        mail(vendorToOwner, {
          bodyText: "---------- Forwarded message ---------\nOrder SYN-100",
        }),
        evidence,
      ),
    ).toBeNull();
  });

  it("leaves Cc-only delivery to the model", () => {
    expect(
      ownMailAttribution(
        mail({
          from: "orders@kettle.example",
          to: "friend@elsewhere.example.test",
          cc: "sam@home.example.test",
          "delivered-to": "samexample@gmail.com",
        }),
        evidence,
      ),
    ).toBeNull();
  });

  it("leaves a household member's mail to the model", () => {
    expect(
      ownMailAttribution(
        mail({
          from: "Alex Example <alex@home.example.test>",
          to: "sam@home.example.test",
        }),
        evidence,
      ),
    ).toBeNull();
  });

  it("decides nothing without owner evidence", () => {
    expect(ownMailAttribution(mail(vendorToOwner), null)).toBeNull();
  });
});
