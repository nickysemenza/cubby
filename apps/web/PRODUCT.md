# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Cubby serves its owner and a tiny, mutually trusted household. They use the web app on desktop and as an iOS-focused PWA while cooking, planning meals, recounting inventory, organizing the home, and reviewing household projects and spending.

Their core jobs are to understand what the household owns, where it lives, what it cost, and what can be cooked from it without maintaining a brittle, exact-consumption ledger; and to preserve a useful history of household projects through their tasks and purchases.

## Product Purpose

Cubby is a personal household operating system with two north stars:

1. Tie recipes to physical inventory so “What can I cook tonight, and what would it cost?” is answerable from the recipes and products the household already maintains.
2. Track household projects through both the work being done and the money being spent, connecting projects to their tasks and purchases.

Meals, locations, products, vendors, expenses, financial reconciliation, and related planning workflows support those two foundations. Success means the household can understand its food, belongings, work, and spending from one connected body of data while keeping maintenance deliberate and proportionate to a personal tool.

## Positioning

Cubby joins recipes to specific stocked products, locations, prices, unit mappings, and availability while also joining household projects to their tasks, purchases, and expense lines. Its position is the combination of physical household knowledge with operational and financial project history: recipe managers or pantry lists do not offer the same cookability-and-cost mechanism, while generic task or expense trackers do not preserve the same connection between household work, what was bought, and what the household owns.

## Operating Context

- Desktop use supports dense browsing, editing, comparison, planning, visualization, reconciliation, and project tracking.
- The installable iOS PWA supports phone-first work in the physical household, including barcode capture and deliberate inventory recounts. The app shell can work offline, but writes require a network connection.
- Inventory truth is restored through an intentional recount rather than inferred from cooking or other activity.
- Cookbook and EPUB import are rare, interactive workflows performed with a person watching.
- Household users are trusted and may see household-wide operational data and user or client attribution.
- Public shortcodes identify entities in URLs, integrations, and printed labels; internal UUIDs remain private implementation details.

## Capabilities and Constraints

- Manage products, approximate inventory quantities, hierarchical locations, images, and printable location labels.
- Maintain multi-section recipes, nested recipe composition, unit conversions, costing, scaling, comparison, preparation views, and cookbook imports.
- Plan meals, derive shopping needs from planned meals and on-hand inventory, and suggest recipes from availability.
- Track household projects, tasks, vendors, purchases, expense lines, reusable tool usage, wishes, financial accounts, and settlement transactions.
- Search, audit, visualize, and access household entities through the authenticated web UI and MCP integrations.
- Inventory is a ballpark, not a ledger. Nothing automatically decrements inventory; consumption is always an explicit human action.
- USDA FoodData Central identity belongs to a specific Product, never directly to an abstract Ingredient. Nutrition resolves through `ingredient → product → fdc_id`.
- All spend lives on `Expense` and is calculated from `SUM(expense.cost)`. `Purchase.statedTotal` is only a reconciliation cue and is never summed into spend.
- Financial transactions provide settlement evidence and never change spend.
- Cubby is not a multi-tenant SaaS, social network, commerce or ordering tool, or cross-platform mobile product. Mobile support is intentionally iOS-only.
- The household model does not require tenant isolation, multi-user coordination, reservations, locking, or user-facing restore and undo flows.
- Rare interactive work stays interactive rather than acquiring background-job infrastructure. Background processing is reserved for frequent, unattended, or request-breaking work.

## Brand Commitments

- The product name is **Cubby**.
- Cubby is an earnest daily-use household utility and a high-craft personal engineering playground, not a commercial service marketed to strangers.
- Product language should be direct, practical, precise, and at home in the household rather than promotional or enterprise-oriented.
- Existing Cubby marks and install assets live in `public/favicon.svg`, `public/apple-touch-icon.png`, and the PWA icon and splash assets under `public/`.

## Evidence on Hand

- `../../README.md` is the canonical source for Cubby’s purpose, tenets, capabilities, architecture, entities, operating constraints, and roadmap.
- `../../docs/inventory-audit.md` records the deliberate recount model and its known workflow constraints.
- `../../docs/terminology.md` is the canonical glossary for distinctions such as Vendor, Purchase, Expense, and settlement evidence.
- `../../docs/todos.md` contains the authoritative product backlog and preserved design decisions.
- The existing authenticated routes under `src/routes/` demonstrate the shipped inventory, recipe, meal, planning, project, spending, reconciliation, search, USDA, and administration workflows.
- `public/manifest.json` and the PWA assets under `public/` demonstrate the installable, iOS-focused web experience.
- The repository contains no approved testimonials, customer claims, press, commercial metrics, or public benchmarks. Future work must not fabricate them.
- Real household records, third-party names, financial details, order identifiers, addresses, screenshots, or other private production data must never appear in outward-facing copy, examples, fixtures, commits, pull requests, or other public artifacts.

## Product Principles

1. **Tie recipes to physical reality.** Preserve the connection among recipes, specific products, approximate stock, location, unit conversion, and cost.
2. **Make project history complete.** Keep the work and the spend together by connecting household projects to both tasks and purchases.
3. **Prefer useful estimates to false precision.** Inventory supports decisions without pretending passive activity can maintain exact counts.
4. **Keep household work proportionate.** Favor deliberate, understandable workflows over industrial machinery for rare or supervised tasks.
5. **Maintain one source of truth per concept.** Product identity owns USDA links, Expense owns spend, and financial transactions remain settlement evidence.
6. **Optimize for one trusted household.** Choose speed, recoverability, and practical daily use over SaaS, social, commerce, and multi-user coordination concerns.
