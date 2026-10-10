import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { describe, expect, it } from "vitest";

import {
  FIELD_SUGGEST_REGISTRY,
  fieldSuggestSpecFor,
} from "~/server/ai/field-suggest/registry";

describe("suggestion enum descriptions", () => {
  it("preserves rendered enum prompt/spec text for every enum suggest key", () => {
    const rendered = Object.entries(FIELD_SUGGEST_REGISTRY)
      .filter(([, spec]) => spec.kind === "enum")
      .map(([key, spec]) => {
        const separator = key.indexOf(".");
        const entity = key.slice(0, separator);
        const field = key.slice(separator + 1);
        const model = Object.entries(entityFieldModels).find(
          ([name]) => name === entity,
        )?.[1];
        const manifestField = model?.fields.find(
          (candidate) => candidate.key === field,
        );
        if (spec.kind !== "enum") throw new Error(`${key} is not an enum`);
        const renderedSpec = fieldSuggestSpecFor(entity, field);
        if (renderedSpec?.kind !== "enum")
          throw new Error(`${key} does not resolve to an enum suggestion`);
        return {
          key,
          basis: manifestField?.control?.suggest?.basis,
          rules: spec.rules,
          options: manifestField?.control?.options?.map((option) => ({
            value: option.value,
            label: option.label,
            description: renderedSpec.describe(option.value),
          })),
        };
      });

    const capturedOrder = [
      "vendor.spendingProfile",
      "vendor.evidenceExpectation",
      "purchase.evidenceExpectation",
      "financialTransaction.evidenceExpectation",
      "spendingCategory.evidenceExpectation",
      "spendingCategory.productExpectation",
      "planting.status",
      "gardenEntry.kind",
      "location.type",
      "project.kind",
      "project.defaultTrade",
      "meal.mealType",
      "meal.mealKind",
      "task.trade",
      "expense.costType",
      "expense.lineKind",
      "expense.trade",
      "purchase.defaultTrade",
      "productCategory.feature",
    ];
    rendered.sort(
      (left, right) =>
        capturedOrder.indexOf(left.key) - capturedOrder.indexOf(right.key),
    );

    expect(rendered).toMatchInlineSnapshot(`
      [
        {
          "basis": [
            "name",
            "website",
            "notes",
          ],
          "key": "vendor.spendingProfile",
          "options": [
            {
              "description": "Insufficient evidence",
              "label": "Unspecified",
              "value": "unspecified",
            },
            {
              "description": "Mixed retailer selling multiple kinds of goods",
              "label": "Mixed retailer",
              "value": "mixed_retail",
            },
            {
              "description": "Groceries and food retail",
              "label": "Groceries",
              "value": "food_retail",
            },
            {
              "description": "Prepared restaurant meals",
              "label": "Restaurant",
              "value": "restaurant",
            },
            {
              "description": "Coffee shop",
              "label": "Coffee shop",
              "value": "coffee_shop",
            },
          ],
          "rules": "Suggest this vendor's spending profile using saved independent purchase and ProductCategory evidence. Food products alone do not distinguish groceries from restaurant meals. Mixed goods support mixed_retail; ambiguous or truncated evidence supports unspecified. The current profile is a review target, never proof. Return a proposal only.",
        },
        {
          "basis": [
            "name",
            "website",
            "notes",
          ],
          "key": "vendor.evidenceExpectation",
          "options": [
            {
              "description": "Insufficient or mixed evidence; leave receipt expectation unclassified",
              "label": "Unclassified",
              "value": "unknown",
            },
            {
              "description": "Household expects a receipt or order evidence",
              "label": "Expected",
              "value": "required",
            },
            {
              "description": "Household does not expect receipt or order evidence",
              "label": "Not expected",
              "value": "not_expected",
            },
          ],
          "rules": "Suggest the household's receipt/order evidence expectation, not whether a merchant is capable of issuing receipts. Amazon and Home Depot purchases are expected (required). Restaurant meals, BiRite groceries and friend reimbursements are not_expected. Use the actual purchase/source description when available; broad or mixed vendor/category evidence without a clear purpose remains unknown. Missing receipt evidence alone never means not_expected. Return a reviewed proposal only; never overwrite explicit decisions.",
        },
        {
          "basis": [
            "displayLabel",
            "vendorId",
            "spendingCategoryId",
            "notes",
          ],
          "key": "purchase.evidenceExpectation",
          "options": [
            {
              "description": "Insufficient or mixed evidence; leave receipt expectation unclassified",
              "label": "Unclassified",
              "value": "unknown",
            },
            {
              "description": "Household expects a receipt or order evidence",
              "label": "Expected",
              "value": "required",
            },
            {
              "description": "Household does not expect receipt or order evidence",
              "label": "Not expected",
              "value": "not_expected",
            },
          ],
          "rules": "Suggest the household's receipt/order evidence expectation, not whether a merchant is capable of issuing receipts. Amazon and Home Depot purchases are expected (required). Restaurant meals, BiRite groceries and friend reimbursements are not_expected. Use the actual purchase/source description when available; broad or mixed vendor/category evidence without a clear purpose remains unknown. Missing receipt evidence alone never means not_expected. Return a reviewed proposal only; never overwrite explicit decisions.",
        },
        {
          "basis": [
            "purchaseId",
            "spendingCategoryId",
            "merchant",
            "rawDescription",
            "sourceCategory",
            "kind",
            "notes",
          ],
          "key": "financialTransaction.evidenceExpectation",
          "options": [
            {
              "description": "Insufficient or mixed evidence; leave receipt expectation unclassified",
              "label": "Unclassified",
              "value": "unknown",
            },
            {
              "description": "Household expects a receipt or order evidence",
              "label": "Expected",
              "value": "required",
            },
            {
              "description": "Household does not expect receipt or order evidence",
              "label": "Not expected",
              "value": "not_expected",
            },
          ],
          "rules": "Suggest the household's receipt/order evidence expectation, not whether a merchant is capable of issuing receipts. Amazon and Home Depot purchases are expected (required). Restaurant meals, BiRite groceries and friend reimbursements are not_expected. Use the actual purchase/source description when available; broad or mixed vendor/category evidence without a clear purpose remains unknown. Missing receipt evidence alone never means not_expected. Return a reviewed proposal only; never overwrite explicit decisions.",
        },
        {
          "basis": [
            "name",
            "parentId",
          ],
          "key": "spendingCategory.evidenceExpectation",
          "options": [
            {
              "description": "Insufficient or mixed evidence; leave receipt expectation unclassified",
              "label": "Unclassified",
              "value": "unknown",
            },
            {
              "description": "Household expects a receipt or order evidence",
              "label": "Expected",
              "value": "required",
            },
            {
              "description": "Household does not expect receipt or order evidence",
              "label": "Not expected",
              "value": "not_expected",
            },
          ],
          "rules": "Suggest the household's receipt/order evidence expectation, not whether a merchant is capable of issuing receipts. Amazon and Home Depot purchases are expected (required). Restaurant meals, BiRite groceries and friend reimbursements are not_expected. Use the actual purchase/source description when available; broad or mixed vendor/category evidence without a clear purpose remains unknown. Missing receipt evidence alone never means not_expected. Return a reviewed proposal only; never overwrite explicit decisions.",
        },
        {
          "basis": [
            "name",
            "parentId",
          ],
          "key": "spendingCategory.productExpectation",
          "options": [
            {
              "description": "Insufficient or mixed evidence; leave receipt expectation unclassified",
              "label": "Unclassified",
              "value": "unknown",
            },
            {
              "description": "Household expects a receipt or order evidence",
              "label": "Expected",
              "value": "required",
            },
            {
              "description": "Household does not expect receipt or order evidence",
              "label": "Not expected",
              "value": "not_expected",
            },
            {
              "description": "Restaurant meals, event tickets, rides and donations never link a Product",
              "label": "Not allowed",
              "value": "not_allowed",
            },
          ],
          "rules": "Suggest Product expectation independently from receipt expectation using the spending category and parent context. Durable goods such as tools, furniture, clothing and tracked software require Product records (required). Groceries, services and friend reimbursements do not require one but may link one (not_expected). Restaurant meals, event tickets, rides and donations can never be a Product (not_allowed); choose not_allowed only when every Expense in the category is such spending. A mixed or unclear category must remain unknown. Do not infer that every receipted purchase requires Products. Return a reviewed proposal only; never overwrite explicit decisions.",
        },
        {
          "basis": [
            "transplantedOn",
            "finishedOn",
          ],
          "key": "planting.status",
          "options": [
            {
              "description": "Planned for a future or not-yet-established planting",
              "label": "Planned",
              "value": "planned",
            },
            {
              "description": "Currently transplanted or actively growing",
              "label": "Growing",
              "value": "growing",
            },
            {
              "description": "No longer growing or completed",
              "label": "Finished",
              "value": "finished",
            },
          ],
          "rules": "Infer the planting lifecycle status from its dates, compared with Today. A finished date on or before Today indicates finished. A sow or transplant date on or before Today indicates growing. A sow or transplant date after Today is an estimate on a planned planting, so choose planned; with no dates choose planned.",
        },
        {
          "basis": [
            "harvestAmount",
            "notes",
          ],
          "key": "gardenEntry.kind",
          "options": [
            {
              "description": "A note, observation, or photo record",
              "label": "Note",
              "value": "note",
            },
            {
              "description": "A record of gathered produce",
              "label": "Harvest",
              "value": "harvest",
            },
          ],
          "rules": "Choose harvest when a harvest amount is present; otherwise choose note for an observation or photo journal entry.",
        },
        {
          "basis": [
            "name",
          ],
          "key": "location.type",
          "options": [
            {
              "description": "The complete household or property: Home",
              "label": "house",
              "value": "house",
            },
            {
              "description": "Large spaces in a building: workshop, garage, kitchen, office, bedroom, basement, attic",
              "label": "room",
              "value": "room",
            },
            {
              "description": "Zones or sections within rooms: workbench area, cutting station, charging station, reading nook",
              "label": "area",
              "value": "area",
            },
            {
              "description": "Outdoor in-ground or raised garden beds: raised bed 1, front garden bed",
              "label": "bed",
              "value": "bed",
            },
            {
              "description": "Outdoor pots and containers for growing: patio planter, hanging planter",
              "label": "planter",
              "value": "planter",
            },
            {
              "description": "Fabric or plastic bags: tool bag, shopping bag, parts bag",
              "label": "bag",
              "value": "bag",
            },
            {
              "description": "Cardboard or plastic boxes, crates and totes: shipping box, storage box, parts box, stackable crate",
              "label": "box",
              "value": "box",
            },
            {
              "description": "Horizontal storage surfaces: top shelf, shelf 3, wall shelf, closet shelf",
              "label": "shelf",
              "value": "shelf",
            },
            {
              "description": "Work surfaces: workbench, desk, countertop, craft table",
              "label": "table",
              "value": "table",
            },
            {
              "description": "Pull-out compartments: desk drawer, toolbox drawer, kitchen drawer",
              "label": "drawer",
              "value": "drawer",
            },
            {
              "description": "Mobile storage with wheels: tool cart, utility cart, rolling cart",
              "label": "cart",
              "value": "cart",
            },
            {
              "description": "Enclosed storage with doors: tool cabinet, kitchen cabinet, medicine cabinet",
              "label": "cabinet",
              "value": "cabinet",
            },
            {
              "description": "A specific catalogued product used as a place: a labelled tote, bin or rack",
              "label": "furniture",
              "value": "furniture",
            },
          ],
          "rules": "You are a location classification assistant. Given a location name, determine the most appropriate location type.

      Rules:
      1. Look for keywords in the name that indicate the type (e.g., "shelf" in name suggests shelf type)
      2. Consider the hierarchy: rooms contain areas, areas contain shelves/cabinets/drawers, etc.
      3. For ambiguous names, consider the most likely physical form
      4. Names with numbers often indicate shelves or drawers (e.g., "Shelf 3", "Drawer 2")
      5. Names mentioning "workbench" or "station" are typically areas or tables",
        },
        {
          "basis": [
            "name",
            "notes",
          ],
          "key": "project.kind",
          "options": [
            {
              "description": "Building or restoring a piece of furniture",
              "label": "Furniture",
              "value": "furniture",
            },
            {
              "description": "Shop infrastructure, tooling, and workspace setup",
              "label": "Workshop",
              "value": "workshop",
            },
            {
              "description": "General household projects not tied to a room renovation",
              "label": "Household",
              "value": "household",
            },
            {
              "description": "Renovating or remodeling a room or structure",
              "label": "Renovation",
              "value": "renovation",
            },
            {
              "description": "Outdoor planting, landscaping, and yard projects",
              "label": "Garden",
              "value": "garden",
            },
            {
              "description": "Travel and trip planning",
              "label": "Trip",
              "value": "trip",
            },
          ],
          "rules": "You are a project classification assistant. Given a project name and notes, determine the most appropriate kind.

      Rules:
      1. Match the primary subject of the project, not incidental tasks within it.
      2. A room or structure name (kitchen, deck, garage) usually indicates "renovation".
      3. A single object being built or fixed usually indicates "furniture".",
        },
        {
          "basis": [
            "name",
            "notes",
            "kind",
          ],
          "key": "project.defaultTrade",
          "options": [
            {
              "description": "Design, permits, estimates, and pre-work decisions",
              "label": "Planning",
              "value": "planning",
            },
            {
              "description": "Teardown, removal, and job-site cleanup of what's replaced",
              "label": "Demo & Cleanup",
              "value": "demolition",
            },
            {
              "description": "Framing, structural carpentry, and rough construction",
              "label": "Building & Framing",
              "value": "building",
            },
            {
              "description": "Hanging, taping, mudding, and patching drywall",
              "label": "Drywall",
              "value": "drywall",
            },
            {
              "description": "Wiring, outlets, switches, lighting fixtures, breakers, low-voltage",
              "label": "Electrical & Lighting",
              "value": "electrical",
            },
            {
              "description": "Pipes, fixtures, drains, water heaters, supply and waste lines",
              "label": "Plumbing",
              "value": "plumbing",
            },
            {
              "description": "HVAC, ductwork, furnaces, heat pumps, ventilation",
              "label": "Mechanical / HVAC",
              "value": "mechanical",
            },
            {
              "description": "Built-in and freestanding cabinets, cabinet hardware and install",
              "label": "Cabinetry",
              "value": "cabinetry",
            },
            {
              "description": "Countertop fabrication, templating, and installation",
              "label": "Countertops",
              "value": "countertop",
            },
            {
              "description": "Subfloor, tile, hardwood, carpet, and floor finishing",
              "label": "Flooring",
              "value": "flooring",
            },
            {
              "description": "Trim, molding, doors, casing, and finish carpentry",
              "label": "Trim & Millwork",
              "value": "millwork",
            },
            {
              "description": "Paint, stain, caulk, and other surface finishing",
              "label": "Paint & Finishes",
              "value": "finishes",
            },
            {
              "description": "Major appliances and furniture selection, delivery, and install",
              "label": "Appliances & Furniture",
              "value": "appliances",
            },
            {
              "description": "Yard work, planting, hardscape, irrigation, fencing",
              "label": "Landscaping",
              "value": "landscaping",
            },
            {
              "description": "Moving, hauling, storage, and job-site coordination",
              "label": "Logistics & Moving",
              "value": "logistics",
            },
            {
              "description": "Welding, fabrication, and metal machining",
              "label": "Metalworking",
              "value": "metalworking",
            },
            {
              "description": "Arts, crafts, and small hand-made projects",
              "label": "Arts & Crafts",
              "value": "crafts",
            },
            {
              "description": "Vehicle maintenance, repair, and parts",
              "label": "Auto",
              "value": "auto",
            },
            {
              "description": "Anything that doesn't fit a listed trade",
              "label": "Other",
              "value": "other",
            },
          ],
          "rules": "You are a home-project trade classification assistant. Given a task or expense name and its available context, determine the most appropriate trade.

      Rules:
      1. Match the physical work being described, not the room it happens in.
      2. A product or vendor name is a strong signal: electrical supply vendors imply "electrical", lumber implies "building".
      3. Prefer the most specific trade that fits over "other".
      4. "planning" is for pre-work (design, permits, estimates), not the work itself.",
        },
        {
          "basis": [
            "name",
          ],
          "key": "meal.mealType",
          "options": [
            {
              "description": "Morning meal",
              "label": "Breakfast",
              "value": "breakfast",
            },
            {
              "description": "Late-morning meal combining breakfast and lunch",
              "label": "Brunch",
              "value": "brunch",
            },
            {
              "description": "Midday meal",
              "label": "Lunch",
              "value": "lunch",
            },
            {
              "description": "A small bite between meals",
              "label": "Snack",
              "value": "snack",
            },
            {
              "description": "Evening meal",
              "label": "Dinner",
              "value": "dinner",
            },
            {
              "description": "A sweet course, usually after dinner",
              "label": "Dessert",
              "value": "dessert",
            },
          ],
          "rules": "You are a meal-planning classification assistant. Given a meal name, determine which eating occasion of the day it is.

      Rules:
      1. Use the name's timing and dish cues (e.g., "pancakes" suggests breakfast, "birthday cake" suggests dessert).
      2. When the name gives no timing cue, prefer "dinner" — the most common unslotted meal.",
        },
        {
          "basis": [
            "name",
          ],
          "key": "meal.mealKind",
          "options": [
            {
              "description": "Cooked at home from a recipe",
              "label": "Cooked",
              "value": "cooked",
            },
            {
              "description": "Reheated food from an earlier meal",
              "label": "Leftovers",
              "value": "leftovers",
            },
            {
              "description": "Eaten at a restaurant",
              "label": "Eating out",
              "value": "eating_out",
            },
            {
              "description": "Ordered for pickup or delivery",
              "label": "Takeout / delivery",
              "value": "takeout",
            },
            {
              "description": "Doesn't fit a listed kind",
              "label": "Other",
              "value": "other",
            },
          ],
          "rules": "You are a meal-planning classification assistant. Given a meal name, determine how the meal is eaten.

      Rules:
      1. A named dish with no restaurant/delivery cue is "cooked".
      2. "leftovers" only when the name says so explicitly.
      3. Restaurant or delivery-service names indicate "eating_out" or "takeout" respectively.",
        },
        {
          "basis": [
            "name",
            "projectId",
          ],
          "key": "task.trade",
          "options": [
            {
              "description": "Design, permits, estimates, and pre-work decisions",
              "label": "Planning",
              "value": "planning",
            },
            {
              "description": "Teardown, removal, and job-site cleanup of what's replaced",
              "label": "Demo & Cleanup",
              "value": "demolition",
            },
            {
              "description": "Framing, structural carpentry, and rough construction",
              "label": "Building & Framing",
              "value": "building",
            },
            {
              "description": "Hanging, taping, mudding, and patching drywall",
              "label": "Drywall",
              "value": "drywall",
            },
            {
              "description": "Wiring, outlets, switches, lighting fixtures, breakers, low-voltage",
              "label": "Electrical & Lighting",
              "value": "electrical",
            },
            {
              "description": "Pipes, fixtures, drains, water heaters, supply and waste lines",
              "label": "Plumbing",
              "value": "plumbing",
            },
            {
              "description": "HVAC, ductwork, furnaces, heat pumps, ventilation",
              "label": "Mechanical / HVAC",
              "value": "mechanical",
            },
            {
              "description": "Built-in and freestanding cabinets, cabinet hardware and install",
              "label": "Cabinetry",
              "value": "cabinetry",
            },
            {
              "description": "Countertop fabrication, templating, and installation",
              "label": "Countertops",
              "value": "countertop",
            },
            {
              "description": "Subfloor, tile, hardwood, carpet, and floor finishing",
              "label": "Flooring",
              "value": "flooring",
            },
            {
              "description": "Trim, molding, doors, casing, and finish carpentry",
              "label": "Trim & Millwork",
              "value": "millwork",
            },
            {
              "description": "Paint, stain, caulk, and other surface finishing",
              "label": "Paint & Finishes",
              "value": "finishes",
            },
            {
              "description": "Major appliances and furniture selection, delivery, and install",
              "label": "Appliances & Furniture",
              "value": "appliances",
            },
            {
              "description": "Yard work, planting, hardscape, irrigation, fencing",
              "label": "Landscaping",
              "value": "landscaping",
            },
            {
              "description": "Moving, hauling, storage, and job-site coordination",
              "label": "Logistics & Moving",
              "value": "logistics",
            },
            {
              "description": "Welding, fabrication, and metal machining",
              "label": "Metalworking",
              "value": "metalworking",
            },
            {
              "description": "Arts, crafts, and small hand-made projects",
              "label": "Arts & Crafts",
              "value": "crafts",
            },
            {
              "description": "Vehicle maintenance, repair, and parts",
              "label": "Auto",
              "value": "auto",
            },
            {
              "description": "Anything that doesn't fit a listed trade",
              "label": "Other",
              "value": "other",
            },
          ],
          "rules": "You are a home-project trade classification assistant. Given a task or expense name and its available context, determine the most appropriate trade.

      Rules:
      1. Match the physical work being described, not the room it happens in.
      2. A product or vendor name is a strong signal: electrical supply vendors imply "electrical", lumber implies "building".
      3. Prefer the most specific trade that fits over "other".
      4. "planning" is for pre-work (design, permits, estimates), not the work itself.",
        },
        {
          "basis": [
            "name",
            "productId",
            "vendor",
          ],
          "key": "expense.costType",
          "options": [
            {
              "description": "Physical goods consumed by or installed in the work: lumber, fixtures, fasteners, finishes",
              "label": "Materials",
              "value": "materials",
            },
            {
              "description": "Equipment bought or rented to do the work, not consumed by it",
              "label": "Tools",
              "value": "tools",
            },
            {
              "description": "Paid labor, delivery, permits, or other non-material services",
              "label": "Services",
              "value": "services",
            },
          ],
          "rules": "You are a project-expense classification assistant. Given an expense name and its available context, determine the most appropriate cost type.

      Rules:
      1. A consumed or installed physical good is "materials".
      2. Equipment that outlives the job and isn't consumed by it is "tools".
      3. Paid labor, delivery fees, permits, and other non-material charges are "services".",
        },
        {
          "basis": [
            "name",
            "cost",
            "notes",
          ],
          "key": "expense.lineKind",
          "options": [
            {
              "description": "The main item or service purchased",
              "label": "Item or service",
              "value": "principal",
            },
            {
              "description": "Sales tax or other tax charges",
              "label": "Tax",
              "value": "tax",
            },
            {
              "description": "Shipping, delivery, or freight charges",
              "label": "Shipping or delivery",
              "value": "shipping",
            },
            {
              "description": "Discounts, coupons, or promotional reductions",
              "label": "Discount",
              "value": "discount",
            },
            {
              "description": "Processing, handling, or service fees",
              "label": "Fee",
              "value": "fee",
            },
            {
              "description": "Tips or gratuity",
              "label": "Tip",
              "value": "tip",
            },
            {
              "description": "Other receipt adjustments that don't fit above",
              "label": "Other adjustment",
              "value": "other_adjustment",
            },
          ],
          "rules": "You are a receipt-line classifier. Given an expense's name, cost, and notes, determine the receipt role.

      Rules:
      1. Names containing "tax", "sales tax", "estimated tax" → tax
      2. Names containing "shipping", "delivery", "freight" → shipping
      3. Names containing "discount", "coupon", "credit", "promo", or a negative cost with that wording → discount
      4. Names containing "fee", "processing", "handling" → fee
      5. Names containing "tip", "gratuity" → tip
      6. An explicit receipt adjustment none of the above covers (rounding, price adjustment) → other_adjustment
      7. Otherwise → principal (the main purchased item/service)",
        },
        {
          "basis": [
            "name",
            "notes",
            "productId",
            "vendor",
            "projectId",
          ],
          "key": "expense.trade",
          "options": [
            {
              "description": "Design, permits, estimates, and pre-work decisions",
              "label": "Planning",
              "value": "planning",
            },
            {
              "description": "Teardown, removal, and job-site cleanup of what's replaced",
              "label": "Demo & Cleanup",
              "value": "demolition",
            },
            {
              "description": "Framing, structural carpentry, and rough construction",
              "label": "Building & Framing",
              "value": "building",
            },
            {
              "description": "Hanging, taping, mudding, and patching drywall",
              "label": "Drywall",
              "value": "drywall",
            },
            {
              "description": "Wiring, outlets, switches, lighting fixtures, breakers, low-voltage",
              "label": "Electrical & Lighting",
              "value": "electrical",
            },
            {
              "description": "Pipes, fixtures, drains, water heaters, supply and waste lines",
              "label": "Plumbing",
              "value": "plumbing",
            },
            {
              "description": "HVAC, ductwork, furnaces, heat pumps, ventilation",
              "label": "Mechanical / HVAC",
              "value": "mechanical",
            },
            {
              "description": "Built-in and freestanding cabinets, cabinet hardware and install",
              "label": "Cabinetry",
              "value": "cabinetry",
            },
            {
              "description": "Countertop fabrication, templating, and installation",
              "label": "Countertops",
              "value": "countertop",
            },
            {
              "description": "Subfloor, tile, hardwood, carpet, and floor finishing",
              "label": "Flooring",
              "value": "flooring",
            },
            {
              "description": "Trim, molding, doors, casing, and finish carpentry",
              "label": "Trim & Millwork",
              "value": "millwork",
            },
            {
              "description": "Paint, stain, caulk, and other surface finishing",
              "label": "Paint & Finishes",
              "value": "finishes",
            },
            {
              "description": "Major appliances and furniture selection, delivery, and install",
              "label": "Appliances & Furniture",
              "value": "appliances",
            },
            {
              "description": "Yard work, planting, hardscape, irrigation, fencing",
              "label": "Landscaping",
              "value": "landscaping",
            },
            {
              "description": "Moving, hauling, storage, and job-site coordination",
              "label": "Logistics & Moving",
              "value": "logistics",
            },
            {
              "description": "Welding, fabrication, and metal machining",
              "label": "Metalworking",
              "value": "metalworking",
            },
            {
              "description": "Arts, crafts, and small hand-made projects",
              "label": "Arts & Crafts",
              "value": "crafts",
            },
            {
              "description": "Vehicle maintenance, repair, and parts",
              "label": "Auto",
              "value": "auto",
            },
            {
              "description": "Anything that doesn't fit a listed trade",
              "label": "Other",
              "value": "other",
            },
          ],
          "rules": "You are a home-project trade classification assistant. Given a task or expense name and its available context, determine the most appropriate trade.

      Rules:
      1. Match the physical work being described, not the room it happens in.
      2. A product or vendor name is a strong signal: electrical supply vendors imply "electrical", lumber implies "building".
      3. Prefer the most specific trade that fits over "other".
      4. "planning" is for pre-work (design, permits, estimates), not the work itself.",
        },
        {
          "basis": [
            "displayLabel",
            "vendorId",
            "notes",
          ],
          "key": "purchase.defaultTrade",
          "options": [
            {
              "description": "Design, permits, estimates, and pre-work decisions",
              "label": "Planning",
              "value": "planning",
            },
            {
              "description": "Teardown, removal, and job-site cleanup of what's replaced",
              "label": "Demo & Cleanup",
              "value": "demolition",
            },
            {
              "description": "Framing, structural carpentry, and rough construction",
              "label": "Building & Framing",
              "value": "building",
            },
            {
              "description": "Hanging, taping, mudding, and patching drywall",
              "label": "Drywall",
              "value": "drywall",
            },
            {
              "description": "Wiring, outlets, switches, lighting fixtures, breakers, low-voltage",
              "label": "Electrical & Lighting",
              "value": "electrical",
            },
            {
              "description": "Pipes, fixtures, drains, water heaters, supply and waste lines",
              "label": "Plumbing",
              "value": "plumbing",
            },
            {
              "description": "HVAC, ductwork, furnaces, heat pumps, ventilation",
              "label": "Mechanical / HVAC",
              "value": "mechanical",
            },
            {
              "description": "Built-in and freestanding cabinets, cabinet hardware and install",
              "label": "Cabinetry",
              "value": "cabinetry",
            },
            {
              "description": "Countertop fabrication, templating, and installation",
              "label": "Countertops",
              "value": "countertop",
            },
            {
              "description": "Subfloor, tile, hardwood, carpet, and floor finishing",
              "label": "Flooring",
              "value": "flooring",
            },
            {
              "description": "Trim, molding, doors, casing, and finish carpentry",
              "label": "Trim & Millwork",
              "value": "millwork",
            },
            {
              "description": "Paint, stain, caulk, and other surface finishing",
              "label": "Paint & Finishes",
              "value": "finishes",
            },
            {
              "description": "Major appliances and furniture selection, delivery, and install",
              "label": "Appliances & Furniture",
              "value": "appliances",
            },
            {
              "description": "Yard work, planting, hardscape, irrigation, fencing",
              "label": "Landscaping",
              "value": "landscaping",
            },
            {
              "description": "Moving, hauling, storage, and job-site coordination",
              "label": "Logistics & Moving",
              "value": "logistics",
            },
            {
              "description": "Welding, fabrication, and metal machining",
              "label": "Metalworking",
              "value": "metalworking",
            },
            {
              "description": "Arts, crafts, and small hand-made projects",
              "label": "Arts & Crafts",
              "value": "crafts",
            },
            {
              "description": "Vehicle maintenance, repair, and parts",
              "label": "Auto",
              "value": "auto",
            },
            {
              "description": "Anything that doesn't fit a listed trade",
              "label": "Other",
              "value": "other",
            },
          ],
          "rules": "You are a home-project trade classification assistant. Given a task or expense name and its available context, determine the most appropriate trade.

      Rules:
      1. Match the physical work being described, not the room it happens in.
      2. A product or vendor name is a strong signal: electrical supply vendors imply "electrical", lumber implies "building".
      3. Prefer the most specific trade that fits over "other".
      4. "planning" is for pre-work (design, permits, estimates), not the work itself.",
        },
        {
          "basis": [
            "name",
            "parentId",
          ],
          "key": "productCategory.feature",
          "options": [
            {
              "description": "Edible/consumable products tracked against nutrition (USDA-linkable)",
              "label": "Food",
              "value": "food",
            },
            {
              "description": "Books, manuals, and other bound reading matter",
              "label": "Books",
              "value": "books",
            },
            {
              "description": "Durable hand or power tools",
              "label": "Tools",
              "value": "tools",
            },
            {
              "description": "Consumed alongside tool use: blades, bits, abrasives",
              "label": "Tool consumables",
              "value": "tool-consumables",
            },
            {
              "description": "Non-consumed attachments and add-ons for tools",
              "label": "Tool accessories",
              "value": "tool-accessories",
            },
            {
              "description": "Bins, totes, shelving, and other organizational containers",
              "label": "Storage",
              "value": "storage",
            },
            {
              "description": "Fasteners, fittings, and small hardware components",
              "label": "Hardware",
              "value": "hardware",
            },
            {
              "description": "Electronic devices and components",
              "label": "Electronics",
              "value": "electronics",
            },
            {
              "description": "Software, licenses, and digital subscriptions",
              "label": "Software",
              "value": "software",
            },
            {
              "description": "General household goods with no more specific feature",
              "label": "Household",
              "value": "household",
            },
            {
              "description": "Consumable general-purpose supplies (tape, paper, cleaning, …)",
              "label": "Supplies",
              "value": "supplies",
            },
            {
              "description": "Clothing, footwear, and wearable accessories",
              "label": "Apparel",
              "value": "apparel",
            },
          ],
          "rules": "You are a product-category classification assistant. Given a category's name and its parent category, determine which behavior namespace it belongs to.

      Rules:
      1. Match the category's own subject, not an ancestor's — a feature binds to the nearest category that carries one and descendants inherit it, so only assign a feature this category itself should own.
      2. Prefer the most specific feature that fits over "household", the catch-all — reserve "household" for a genuinely general-purpose category with no more specific behavior.
      3. A consumable used alongside a tool (blades, bits, abrasives) is "tool-consumables"; a durable attachment for one is "tool-accessories"; the tool itself is "tools".",
        },
      ]
    `);
  });

  it("uses the manifest option meaning for an enum choice", () => {
    const field = entityFieldModels.expense.fields.find(
      (candidate) => candidate.key === "lineKind",
    );
    const option = field?.control?.options?.find(
      ({ value }) => value === "tax",
    );
    const spec = fieldSuggestSpecFor("expense", "lineKind");

    expect(option?.description).toBeTruthy();
    expect(spec?.kind).toBe("enum");
    expect(spec?.kind === "enum" ? spec.describe("tax") : undefined).toBe(
      option?.description,
    );
  });

  it("declares a non-empty manifest description for every enum suggestion option", () => {
    for (const [key, registrySpec] of Object.entries(FIELD_SUGGEST_REGISTRY)) {
      if (registrySpec.kind !== "enum") continue;
      const separator = key.indexOf(".");
      const entity = key.slice(0, separator);
      const field = key.slice(separator + 1);
      const model = Object.entries(entityFieldModels).find(
        ([name]) => name === entity,
      )?.[1];
      const options = model?.fields.find((candidate) => candidate.key === field)
        ?.control?.options;
      if (!options?.length) throw new Error(`${key} has no enum options`);

      for (const option of options) {
        expect(
          "description" in option && option.description.trim().length > 0,
        ).toBe(true);
      }

      const spec = fieldSuggestSpecFor(entity, field);
      if (spec?.kind !== "enum")
        throw new Error(`${key} does not resolve to an enum suggestion`);
      for (const option of options) {
        const description =
          "description" in option ? option.description : undefined;
        expect(spec.describe(option.value)).toBe(description);
      }
    }
  });
});
