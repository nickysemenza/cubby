/**
 * Vendor string → domain, the input to `seed-vendor-logos.ts`.
 *
 * Keys are the EXACT values stored in `Vendor.name` (`SELECT name FROM "Vendor"`).
 * There IS a vendor entity now, so the long-term home for a brand domain is a
 * column on it; this map stays a hand-curated file because a wrong domain yields
 * a confidently-wrong logo and a reviewed diff is the right gate for that.
 *
 * Deliberately incomplete. A wrong domain yields a confidently-wrong logo, which
 * is far worse than no logo, so vendors whose domain isn't certain (small local
 * Bay Area suppliers, ambiguous names like "Muller" or "Casson") are simply
 * omitted and fall through to the monogram tile. Add an entry and re-run the
 * script to adopt one.
 */
export const VENDOR_DOMAINS: Record<string, string> = {
  Amazon: "amazon.com",
  "Home Depot": "homedepot.com",
  eBay: "ebay.com",
  "Lowe's": "lowes.com",
  SupplyHouse: "supplyhouse.com",
  "Direct Tools Outlet": "directtoolsoutlet.com",
  "Woodworker Express": "woodworkerexpress.com",
  "Harbor Freight": "harborfreight.com",
  "Golden State Lumber": "goldenstatelumber.com",
  "Sloat Garden Center": "sloatgardens.com",
  Zoro: "zoro.com",
  Rockler: "rockler.com",
  Walmart: "walmart.com",
  "Residence Supply": "residencesupply.com",
  "B&H": "bhphotovideo.com",
  "Rain Bird": "rainbird.com",
  SendCutSend: "sendcutsend.com",
  Woodcraft: "woodcraft.com",
  "Color Atelier": "coloratelier.com",
  "Four Winds Growers": "fourwindsgrowers.com",
  "Urban Farmer": "ufseeds.com",
  "DK Hardware": "dkhardware.com",
  Overstock: "overstock.com",
  DigiKey: "digikey.com",
  Etsy: "etsy.com",
  "Architectural Depot": "architecturaldepot.com",
  "Bambu Lab": "bambulab.com",
  "The Growers Exchange": "thegrowers-exchange.com",
  CabinetParts: "cabinetparts.com",
  "Botanical Interests": "botanicalinterests.com",
  ToolsToday: "toolstoday.com",
  "Flexfire LEDs": "flexfireleds.com",
  SuperBrightLEDs: "superbrightleds.com",
  "Mountain Valley Growers": "mountainvalleygrowers.com",
  "Tool Nut": "toolnut.com",
  "TSO Products": "tsoproducts.com",
  "One Green World": "onegreenworld.com",
  "Acme Tools": "acmetools.com",
  "Flora Grubb Gardens": "floragrubb.com",
  Veradek: "veradek.com",
  "Center Hardware": "centerhardware.com",
  Häfele: "hafele.com",
  "Sherwin-Williams": "sherwin-williams.com",
  Target: "target.com",
  "McMaster-Carr": "mcmaster.com",
  "Penn State Industries": "pennstateind.com",
  Festool: "festoolusa.com",
  "Festool Recon": "festoolusa.com",
  "Northern Tool": "northerntool.com",
  "Ewing Irrigation": "ewingoutdoorsupply.com",
  "Sprinkler Supply Store": "sprinklersupplystore.com",
  "The Evergreen Nursery": "evergreennursery.com",
};
