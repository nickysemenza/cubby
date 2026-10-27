import CubbyKit
import Foundation
import Testing

@testable import Cubby

@Suite("Entity row presentation")
struct EntityRowPresentationTests {
    private func field(_ value: JSONValue) -> JSONValue {
        [
            "current": ["assignment": .null, "controls": ["kind": "readonly", "reason": "computed"]],
            "result": [
                "kind": "live",
                "decision": [
                    "outcome": ["kind": "value", "value": value], "provenance": ["kind": "computed"],
                ],
            ],
            "work": ["kind": "idle"],
        ]
    }

    @Test func productPlacementUsesTheServerPath() throws {
        let descriptor = EntityCatalog[.product]
        let row = try #require(
            descriptor.row(from: [
                "id": "PRD-2345", "name": "Synthetic wrench",
                "fields": [
                    "primaryPlacement": field([
                        "locationId": "LOC-2345", "path": "Home › Garage › Drawer", "onHand": 2,
                    ])
                ],
            ]))
        let presentation = EntityRowPresentation.resolve(
            descriptor: descriptor, row: row, columns: ["primaryPlacement"])
        #expect(presentation.facts.first { $0.id == "primaryPlacement" }?.value == "Home › Garage › Drawer")
    }

    // A self-label timestamp must still reach the shared date presentation, not print raw ISO text.
    @Test func runActivitySelfLabelRetainsDatePresentation() throws {
        let timestamp = "2026-09-12T10:00:00.000Z"
        let row = EntityRow(
            id: "RUN-4K7M", title: "Synthetic run", subtitle: nil, imageURL: nil,
            raw: ["id": "RUN-4K7M", "activityAt": .string(timestamp)])
        let field = try #require(EntityCatalog[.run].fields.first { $0.key == "activityAt" })
        #expect(field.labelPath == "activityAt")
        let fact = try #require(
            EntityRowPresentation.resolve(descriptor: EntityCatalog[.run], row: row, columns: ["activityAt"])
                .facts.first { $0.id == "activityAt" })
        #expect(fact.isDate)
        #expect(fact.dateValue == timestamp)
        let formattedDate = try #require(DatePresentation.absolute(of: timestamp))
        #expect(fact.spokenValue == formattedDate)
    }

    // Today no longer decodes a second meal model; the manifest adapter must retain the
    // recipe context, meal type, navigation identity and display image that its old row showed.
    @Test func todayMealUsesManifestFactsAndDisplayImage() throws {
        let raw: JSONValue = [
            "id": "MEL-2345", "displayName": "Fixture supper",
            "fields": [
                "mealType": field("dinner"), "recipeNames": field(["Fixture stew"]),
                "displayImages": field([["url": "https://example.invalid/meal.jpg"]]),
            ],
        ]
        let row = try #require(EntityCatalog[.meal].row(from: raw))
        let presentation = EntityRowPresentation.resolve(
            descriptor: EntityCatalog[.meal], row: row, columns: ["mealType", "recipeNames"])
        #expect(presentation.title == "Fixture supper")
        #expect(row.id == "MEL-2345")
        #expect(presentation.facts.contains { $0.id == "mealType" && $0.value == "Dinner" })
        #expect(presentation.facts.contains { $0.id == "recipeNames" && $0.value.contains("Fixture stew") })
        #expect(presentation.imageURL?.absoluteString == "https://example.invalid/meal.jpg")
    }

    @Test func titleSubtitleUsesPurchaseCaptionAndVendorContextFact() throws {
        let purchase = EntityCatalog[.purchase]
        let purchaseRow = try #require(
            purchase.row(
                from: [
                    "id": "PUR-1001", "displayName": "Fixture purchase",
                    "displayLabel": "Fixture replacement parts", "vendorId": "VEN-1001",
                    "vendorName": "Fixture supplier",
                ]))
        #expect(purchase.presentation.titleSubtitle)
        #expect(
            (EntityRowPresentation.titleSubtitle(descriptor: purchase, row: purchaseRow)?.value
                ?? purchaseRow.subtitle) == "Fixture replacement parts")

        let vendor = EntityCatalog[.vendor]
        let vendorRow = try #require(
            vendor.row(
                from: [
                    "id": "VEN-1002", "name": "Fixture supplier",
                    "defaultSpendingCategoryId": "SPC-1002",
                    "defaultSpendingCategoryName": "Fixture hardware",
                ]))
        #expect(vendor.presentation.titleSubtitle)
        let vendorPresentation = EntityRowPresentation.resolve(
            descriptor: vendor, row: vendorRow, columns: ["defaultSpendingCategoryId"])
        #expect(
            vendorPresentation.facts.contains {
                $0.id == "defaultSpendingCategoryId" && $0.value == "Fixture hardware"
            })
    }

    @Test func composedTitleMovesADeclaredReferenceSuffixToTheSubtitle() {
        let descriptor = EntityCatalog[.inventory]
        let title = "Synthetic flour bag · Synthetic pantry shelf"
        let row = EntityRow(
            id: "INV-1001", title: title, subtitle: nil, imageURL: nil,
            raw: [
                "id": "INV-1001", "displayName": .string(title),
                "productId": "PRD-1001", "locationId": "LOC-1001",
                "product": ["id": "PRD-1001", "name": "Synthetic flour bag"],
                "location": ["id": "LOC-1001", "name": "Synthetic pantry shelf"],
            ])

        let parts = EntityRowPresentation.titleParts(
            descriptor: descriptor, row: row, subtitle: "Not recorded")

        #expect(parts.title == "Synthetic flour bag")
        #expect(parts.subtitle == "Synthetic pantry shelf")
        #expect(!EntityRowPresentation.isVisibleListFactValue(" Unknown "))
        #expect(!EntityRowPresentation.isVisibleListFactValue("Not recorded"))
        #expect(!EntityRowPresentation.isVisibleListFactValue("  "))
        #expect(EntityRowPresentation.isVisibleListFactValue("Stock"))
    }

    @Test func qualityLeadsSupportingFactsAndDistinguishesUnassessed() {
        let row = EntityRow(
            id: "PRD-1001", title: "Synthetic skillet", subtitle: nil, imageURL: nil,
            raw: [
                "id": "PRD-1001", "name": "Synthetic skillet", "brandId": "VEN-2345",
                "brandName": "Synthetic",
                "fields": ["dataQuality": field(["score": 75, "status": "needs_data"])],
            ])
        let presentation = EntityRowPresentation.resolve(descriptor: EntityCatalog[.product], row: row)
        #expect(presentation.facts.first?.id == "dataQuality")
        #expect(presentation.facts.first?.value == "Needs data")
        #expect(EntityRowPresentation.needsData(in: row))
        let category = EntityRow(
            id: "SPC-1001", title: "Synthetic tools", subtitle: nil, imageURL: nil,
            raw: [
                "id": "SPC-1001", "name": "Synthetic tools",
                "fields": ["dataQuality": field(["score": .null, "status": "not_assessed"])],
            ])
        let unassessed = EntityRowPresentation.resolve(
            descriptor: EntityCatalog[.spendingCategory], row: category)
        #expect(unassessed.facts.first?.value == "Not assessed")
        #expect(!EntityRowPresentation.needsData(in: category))
    }

    /// A Product's owners read comma-joined; only the inherited item carries the marker.
    @Test func resolvedListMarksEachInheritedItem() throws {
        let row = EntityRow(
            id: "PRD-1001", title: "Synthetic skillet", subtitle: nil, imageURL: nil,
            raw: [
                "id": "PRD-1001", "name": "Synthetic skillet",
                "owners": [
                    [
                        "label": "Alex", "ref": ["entityKind": "ledgerParty", "entityId": "LPY-4K7M"],
                        "inherited": true,
                    ],
                    ["label": "Household", "ref": .null, "inherited": false],
                ],
            ])
        let fact = try #require(
            EntityRowPresentation.resolve(descriptor: EntityCatalog[.product], row: row, columns: ["owners"])
                .facts.first { $0.id == "owners" })
        #expect(fact.value == "Alex, Household")
        #expect(fact.segments.map(\.inherited) == [true, false])
        #expect(fact.spokenValue == "Alex, inherited, Household")
        #expect(
            EntityRowPresentation.resolve(descriptor: EntityCatalog[.product], row: row).facts.contains {
                $0.id == "owners"
            })
    }

    /// An inherited owner reads muted with the marker, not an "Inherited · …" caption; a null
    /// owner reads in the declaration's words (Unknown when unset, Household when explicitly
    /// none), and a missing result reads Updating rather than an empty value.
    @Test func inheritedOwnerCarriesTheMarkerAndNullOwnerItsLabel() throws {
        func fact(assignment: JSONValue, result: JSONValue) throws -> EntityRowPresentation.Fact {
            let envelope: JSONValue = [
                "current": [
                    "assignment": assignment,
                    "controls": [
                        "kind": "editable", "canSetNone": true, "canConfirm": true,
                        "reset": ["kind": "unavailable"],
                    ],
                ],
                "result": result, "work": ["kind": "idle"],
            ]
            let row = EntityRow(
                id: "INV-1001", title: "Synthetic entry", subtitle: nil, imageURL: nil,
                raw: ["id": "INV-1001", "fields": ["ownerLedgerPartyId": envelope]])
            return try #require(
                EntityRowPresentation.resolve(
                    descriptor: EntityCatalog[.inventory], row: row, columns: ["ownerLedgerPartyId"]
                ).facts.first { $0.id == "ownerLedgerPartyId" })
        }
        let inherit: JSONValue = ["kind": "inherit"]
        let inherited = try fact(
            assignment: inherit,
            result: [
                "kind": "live",
                "decision": [
                    "outcome": ["kind": "value", "value": "LPY-4K7M"],
                    "provenance": [
                        "kind": "inherited",
                        "source": ["entityKind": "product", "entityId": "PRD-1001", "name": .null],
                    ],
                ],
            ])
        #expect(inherited.inherited)
        #expect(!inherited.value.contains("Inherited"))
        let unset: JSONValue = [
            "kind": "live",
            "decision": ["outcome": ["kind": "empty", "reason": "unset"], "provenance": .null],
        ]
        #expect(try fact(assignment: inherit, result: unset).value == "Unknown")
        let household: JSONValue = [
            "kind": "live",
            "decision": [
                "outcome": ["kind": "empty", "reason": "explicit_none"],
                "provenance": ["kind": "own", "ownership": ["kind": "record"]],
            ],
        ]
        #expect(try fact(assignment: ["kind": "none"], result: household).value == "Household")
        #expect(try !fact(assignment: ["kind": "none"], result: household).inherited)
        #expect(try fact(assignment: inherit, result: ["kind": "missing"]).value == "Updating…")
    }

    /// A scored entity's record can itself be unassessed (null score), and an exceptions-only
    /// record must not read as a plain complete 100.
    @Test func qualityShowsStatusWithoutScores() {
        func quality(_ dataQuality: JSONValue) -> String? {
            let row = EntityRow(
                id: "PRD-1001", title: "Synthetic skillet", subtitle: nil, imageURL: nil,
                raw: [
                    "id": "PRD-1001", "name": "Synthetic skillet",
                    "fields": ["dataQuality": field(dataQuality)],
                ])
            return EntityRowPresentation.resolve(descriptor: EntityCatalog[.product], row: row)
                .facts.first?.value
        }
        #expect(quality(["score": .null, "status": "not_assessed"]) == "Not assessed")
        #expect(quality(["score": 100, "status": "complete_with_exceptions"]) == "Complete with exceptions")
        #expect(quality(["score": 99, "status": "defect"]) == "Defect")
    }

    @Test func resolvesOnlyDeclaredFactsInMetadataOrder() throws {
        let descriptor = EntityCatalog[.product]
        let row = EntityRow(
            id: "PRD-1001", title: "Cast Iron Skillet", subtitle: "ignored", imageURL: nil,
            raw: [
                "id": "PRD-1001", "name": "Cast Iron Skillet", "brandId": "VEN-3456", "brandName": "Lodge",
                "tags": ["kitchen", "cast-iron"], "updatedAt": "2026-09-12T10:00:00.000Z",
            ])

        let presentation = EntityRowPresentation.resolve(
            descriptor: descriptor, row: row, columns: ["tags", "brandId"])

        #expect(presentation.title == "Cast Iron Skillet")
        #expect(presentation.shortcode == "PRD-1001")
        #expect(presentation.facts.map(\.id) == ["dataQuality", "tags", "brandId"])
        #expect(presentation.facts.contains { $0.value == "Lodge" })
        #expect(presentation.facts.contains { $0.value == "kitchen, cast-iron" })
        #expect(presentation.factLine?.contains("Brand: Lodge") == true)
        #expect(presentation.accessibilityText.contains("Brand, Lodge"))
        #expect(!presentation.accessibilityText.contains("PRD-1001"))
    }

    @Test func serverComposedLabelsPrintInsteadOfARederivedFigure() throws {
        let purchase = EntityRow(
            id: "PUR-1001", title: "Order", subtitle: nil, imageURL: nil,
            raw: [
                "id": "PUR-1001", "expenseCount": 4, "expenseCountLabel": "4 · 2 unpriced",
                "reconciliation": "mismatch", "reconciliationLabel": "Needs review -$5.00",
            ])
        let presentation = EntityRowPresentation.resolve(
            descriptor: EntityCatalog[.purchase], row: purchase,
            columns: ["expenseCount", "reconciliation"])
        #expect(presentation.facts.contains { $0.value == "4 · 2 unpriced" })
        #expect(presentation.facts.contains { $0.value == "Needs review -$5.00" })

        // A reference cell names the records it links to, one per element.
        let meal = EntityRow(
            id: "MEL-1001", title: "Supper", subtitle: nil, imageURL: nil,
            raw: [
                "id": "MEL-1001",
                "recipes": [["recipe": ["name": "Soup"]], ["recipe": ["name": "Bread"]]],
            ])
        let mealFacts = EntityRowPresentation.resolve(
            descriptor: EntityCatalog[.meal], row: meal, columns: ["recipes"])
        #expect(mealFacts.facts.contains { $0.value == "Soup, Bread" })
    }

    @Test func relationColumnsResolveRenamedReferencesAndZeroCurrency() throws {
        let descriptor = EntityCatalog[.purchase]
        let row = EntityRow(
            id: "PUR-1001", title: "Order", subtitle: nil, imageURL: nil,
            raw: [
                "id": "PUR-1001", "vendorId": "VND-1", "vendorName": "Sample Vendor",
                "statedTotal": 0,
            ])

        let presentation = EntityRowPresentation.resolve(
            descriptor: descriptor, row: row, columns: ["vendorId", "statedTotal"])

        #expect(presentation.facts.contains { $0.value == "Sample Vendor" })
        #expect(presentation.facts.contains { $0.value == "$0.00" })
        #expect(presentation.factLine?.contains("Vendor: Sample Vendor") == true)
        #expect(presentation.accessibilityText.contains("Vendor, Sample Vendor"))
    }

    @Test func recipeSourcesRenderThroughTheImplementedRenderer() throws {
        let recipe = EntityCatalog[.recipe]
        let book = EntityRow(
            id: "RCP-1001", title: "Soup", subtitle: nil, imageURL: nil,
            raw: [
                "id": "RCP-1001", "name": "Soup",
                "source": ["type": "book", "book": "The Big Book", "cookbookId": "CBK-1"],
            ])
        let website = EntityRow(
            id: "RCP-1002", title: "Soup", subtitle: nil, imageURL: nil,
            raw: [
                "id": "RCP-1002", "name": "Soup",
                "source": ["type": "website", "url": "https://www.example.com/recipe"],
            ])

        #expect(RecipeSourcePresentation.parse(book.raw["source"])?.label == "The Big Book")
        #expect(RecipeSourcePresentation.parse(website.raw["source"])?.label == "example.com")
        #expect(
            EntityRowPresentation.resolve(descriptor: recipe, row: website, columns: ["source"])
                .facts.contains { $0.id == "source" && $0.value == "example.com" }
        )
    }

    @Test func photoRowsPromoteTheEntitySemanticDateNotThePhotoDate() throws {
        let descriptor = EntityCatalog[.meal]
        let row = EntityRow(
            id: "MEA-1001", title: "Dinner", subtitle: nil, imageURL: nil,
            raw: [
                "id": "MEA-1001", "name": "Dinner", "date": "2026-09-08",
                "updatedAt": "2026-09-12T10:00:00.000Z",
            ])

        let presentation = EntityRowPresentation.resolve(
            descriptor: descriptor, row: row, photoMode: true)

        #expect(presentation.facts.first?.id == "date")
        #expect(presentation.facts.first?.value != "2026-09-08")
        #expect(presentation.factLine?.contains("Date:") == true)
        #expect(presentation.accessibilityText.contains("Date,") == true)
        #expect(!presentation.facts.contains { $0.id == "photo-date" })
    }

    @Test func photoModePromotesSemanticDateWithoutCaptureDate() throws {
        let descriptor = EntityCatalog[.gardenEntry]
        let row = EntityRow(
            id: "GDE-1001", title: "Harvest", subtitle: nil, imageURL: nil,
            raw: ["id": "GDE-1001", "displayName": "Harvest", "observedOn": "2026-09-08"])

        let presentation = EntityRowPresentation.resolve(
            descriptor: descriptor, row: row, photoMode: true)

        #expect(presentation.facts.first?.id == "observedOn")
        #expect(presentation.factLine?.contains("Observed on:") == true)
    }

    /// A json field placed in a phone-row slot (financial account `identity`) is a default fact,
    /// read at its declared `readPath` and labelled from `valueOptions`.
    @Test func slottedJSONFieldIsADefaultFact() throws {
        let row = EntityRow(
            id: "FAC-1001", title: "Synthetic card", subtitle: nil, imageURL: nil,
            raw: ["id": "FAC-1001", "name": "Synthetic card", "identity": ["kind": "credit_card"]])
        let fact = try #require(
            EntityRowPresentation.resolve(descriptor: EntityCatalog[.financialAccount], row: row)
                .facts.first { $0.id == "identity" })
        #expect(fact.value == "Credit card")
    }

    /// A `presence` field reads its declared yes/no label, never the linked shortcode.
    @Test func presenceFormatReadsItsLabel() {
        let field = EntityCatalog[.financialTransaction].fields.first { $0.key == "purchasePresence" }!
        let linked = EntityFieldValue.text(
            in: ["id": "FTX-1001", "purchaseId": "PUR-1001"], field: field, surface: "list")
        let unlinked = EntityFieldValue.text(in: ["id": "FTX-1001"], field: field, surface: "list")
        #expect(linked == "Has purchase")
        #expect(unlinked != nil && unlinked != linked)
    }
    @Test func unavailableQualityNeverRevivesATopLevelNeedsDataStatus() {
        let results: [JSONValue] = [
            ["kind": "missing"],
            ["kind": "live", "decision": ["outcome": ["kind": "empty", "reason": "unset"]]],
        ]
        for result in results {
            let row = EntityRow(
                id: "PRD-1001", title: "Synthetic skillet", subtitle: nil, imageURL: nil,
                raw: [
                    "dataQuality": ["status": "needs_data"], "fields": ["dataQuality": ["result": result]],
                ])
            #expect(!EntityRowPresentation.needsData(in: row))
            let fact = EntityRowPresentation.resolve(descriptor: EntityCatalog[.product], row: row).facts
                .first { $0.id == "dataQuality" }
            #expect(fact?.value == "Unavailable")
        }
    }

}
