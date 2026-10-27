import Foundation
import Testing

@testable import CubbyKit

/// Native draws a detail field from what its declaration says to read, never from the shape of
/// the structured value: server-composed text (`detailLabelPath`), display rows (`itemsPath`),
/// a nested value (`readPath`) with the declared `valueOptions` labels.
@Suite("FieldDetailDisplay")
struct FieldDetailDisplayTests {
    private func field(_ entity: EntityKey, _ key: String) throws -> FieldDescriptor {
        try #require(EntityCatalog[entity].field(key))
    }

    @Test func allocatedValuesRemainReadableWhenAssignmentIsRefused() throws {
        let category = try field(.expense, "spendingCategoryId")
        let raw = FieldEnvelopeFixture.row(
            ["lineKind": "shipping"],
            fields: [
                "spendingCategoryId": FieldEnvelopeFixture.envelope(
                    controls: FieldEnvelopeFixture.readonly("allocated"),
                    result: FieldEnvelopeFixture.live(
                        FieldEnvelopeFixture.emptyDecision("mixed", provenance: ["kind": "allocated"])))
            ])
        #expect(category.applicabilityRefusal(in: raw) != nil)
        #expect(category.displayApplicabilityRefusal(in: raw) == nil)
        #expect(category.displayApplicabilityRefusal(in: ["lineKind": "shipping"]) != nil)
    }

    @Test func allocatedProjectsKeepTheirNamesWithoutAScalarTarget() throws {
        let project = try field(.expense, "projectId")
        let raw: JSONValue = [
            "lineKind": "fee", "projectId": .null,
            "projectAllocations": [
                [
                    "projectId": "PRJ-2345", "projectName": "Synthetic first project", "amount": 2,
                    "basis": "positive", "incomplete": false,
                ],
                [
                    "projectId": "PRJ-3456", "projectName": "Synthetic second project", "amount": 3,
                    "basis": "positive", "incomplete": false,
                ],
            ],
            "fields": [
                "projectId": FieldEnvelopeFixture.envelope(
                    controls: FieldEnvelopeFixture.readonly("allocated"),
                    result: FieldEnvelopeFixture.live(
                        FieldEnvelopeFixture.emptyDecision("mixed", provenance: ["kind": "allocated"])))
            ],
        ]
        #expect(project.applicabilityRefusal(in: raw) != nil)
        #expect(project.displayApplicabilityRefusal(in: raw) == nil)
        #expect(
            FieldEnvelopePresentation.allocatedReferenceLabel(in: raw, field: project)
                == "Synthetic first project, Synthetic second project")
    }

    @Test func accountApplicabilityReadsNestedClassifierAndRefusesMissingValues() throws {
        for key in ["network", "primaryCardholderId", "authorizedUsers"] {
            let descriptor = try field(.financialAccount, key)
            #expect(descriptor.applicability?.first?.readPath == "identity.kind")
            for raw: JSONValue in [
                ["identity": ["kind": "bank"]], [:], ["identity": .null],
                ["identity": ["kind": "future_kind"], "network": "visa"],
            ] {
                #expect(descriptor.applicabilityRefusal(in: raw) == "Only applies to credit-card accounts.")
            }
            // Empty applicable fields and effective inherited values remain eligible for actions.
            #expect(descriptor.applicabilityRefusal(in: ["identity": ["kind": "credit_card"]]) == nil)
        }
        #expect(try field(.financialAccount, "identity").applicabilityRefusal(in: [:]) == nil)
    }

    // MARK: - Server-composed text

    @Test func structuredDetailFieldsDeclareWhereTheServerPutsTheirText() throws {
        let declared: [(EntityKey, String, String)] = [
            (.productCategory, "path", "pathLabel"),
            (.financialAccount, "sourceAliases", "sourceAliasesLabel"),
            (.financialAccount, "cardNumbers", "cardNumbersLabel"),
            (.financialTransaction, "sourceRefs", "sourceRefsLabel"),
            (.financialTransaction, "vendorInference", "possibleVendorLabel"),
            (.vendor, "agentHints", "agentHintsLabel"),
            (.recipe, "sections", "compositionLabel"),
            (.recipe, "totals", "totalsLabel"),
            (.image, "provenanceEvidence", "provenanceEvidenceLabel"),
        ]
        for (entity, key, label) in declared {
            #expect(try field(entity, key).detailLabelPath == label, "\(entity).\(key)")
        }
    }

    /// A structured value on a detail page needs something native can print: server text, rows,
    /// a nested value, or a display format (an amount). Product external
    /// IDs declared none, so the row read "1 item" while web showed the identifiers.
    @Test func everyStructuredDetailFieldDeclaresWhatToPrint() {
        let silent = EntityCatalog.all.flatMap { descriptor in
            descriptor.fields
                .filter {
                    $0.showInDetail && $0.valueSchema != nil && $0.detailLabelPath == nil
                        && $0.itemsPath == nil && $0.readPath == nil && $0.format == nil
                }
                .map { "\(descriptor.key.rawValue).\($0.key)" }
        }
        #expect(silent == [], "\(silent)")
    }

    @Test func aDetailLabelIsTheTextTheRecordCarriesLineBreaksKept() throws {
        let cards = try field(.financialAccount, "cardNumbers")
        let raw: JSONValue = [
            "cardNumbers": [["last4": "1234"]],
            "cardNumbersLabel": "•••• 1234 · primary\n•••• 9876 · wallet token",
        ]
        #expect(cards.detailLabel(in: raw) == "•••• 1234 · primary\n•••• 9876 · wallet token")
        // No label means the row is empty, never a count of the structure.
        #expect(cards.detailLabel(in: ["cardNumbers": [], "cardNumbersLabel": .null]) == nil)
        #expect(cards.detailLabel(in: ["cardNumbers": [["last4": "1234"]]]) == nil)
    }

    // MARK: - A nested value with declared option labels

    @Test func identityReadsItsKindThroughTheDeclaredLabels() throws {
        let identity = try field(.financialAccount, "identity")
        let raw: JSONValue = ["identity": ["kind": "stored_value", "provider": "Corner Store"]]
        let value = try #require(identity.detailValue(in: raw))
        #expect(value == "stored_value")
        #expect(identity.optionLabel(for: value) == "Gift card or store credit")
    }

    @Test func aTransferClassificationReadsAsItsDeclaredLabel() throws {
        let classification = try field(.ledgerTransfer, "classification")
        let value = try #require(classification.detailValue(in: ["classification": "internal_move"]))
        #expect(classification.optionLabel(for: value) == "Internal move")
        #expect(classification.optionLabel(for: "not_a_declared_option") == nil)
    }

    @Test func aRecipeShowsItsSourceUrlAndYieldThroughTheirDeclaredPaths() throws {
        let meta = try field(.recipe, "meta")
        #expect(meta.readPath == "meta.url")
        #expect(meta.label == "Source URL")
        #expect(
            meta.detailValue(in: ["meta": ["url": "https://recipes.example.test/soup"]])
                == "https://recipes.example.test/soup")
        #expect(try field(.recipe, "yield").format == "amount")
    }

    // MARK: - Display rows

    @Test func wishCandidatesAreDisplayRowsThatOpenTheirProduct() throws {
        let candidates = try field(.wish, "candidates")
        #expect(candidates.itemsPath == "candidateItems")
        let raw: JSONValue = [
            "candidateItems": [
                [
                    "entity": "product", "id": "PRD-4K7M", "title": "Cast Iron Skillet",
                    "subtitle": "Acme · CI-12", "trailing": "$34.50 · In inventory",
                ],
                [
                    "entity": .null, "id": .null, "title": "Open-ended idea", "subtitle": .null,
                    "trailing": .null,
                ],
            ]
        ]
        let items = candidates.detailItems(in: raw)
        #expect(items.count == 2)
        #expect(items[0].entity == .product)
        #expect(items[0].id == "PRD-4K7M")
        #expect(items[0].subtitle == "Acme · CI-12")
        #expect(items[0].trailing == "$34.50 · In inventory")
        #expect(items[1].entity == nil)
        #expect(candidates.detailItems(in: ["candidateItems": .null]).isEmpty)
        #expect(candidates.detailItems(in: [:]).isEmpty)
    }
}
