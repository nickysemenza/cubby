import Foundation
import Testing

@testable import CubbyKit

/// `NativeCoverageManifest.shared` decodes the bundled `native-coverage.json` (declared in
/// `packages/schemas/src/native-coverage.ts`) and traps when it cannot. The generator already
/// refuses an unclassified id; these tests pin the Swift side of that contract.
@Suite("NativeCoverage")
struct NativeCoverageTests {
    private let coverage = NativeCoverageManifest.shared

    @Test func classifiesEveryGeneratedId() {
        #expect(Set(coverage.control.keys) == Set(ControlRendererID.allCases.map(\.rawValue)))
        #expect(Set(coverage.list.keys) == Set(ListRendererID.allCases.map(\.rawValue)))
        #expect(Set(coverage.detail.keys) == Set(DetailRendererID.allCases.map(\.rawValue)))
        #expect(Set(coverage.heroAction.keys) == Set(EntityHeroActionID.allCases.map(\.rawValue)))
        #expect(Set(coverage.detailSlot.keys) == Set(EntityDetailSlotID.allCases.map(\.rawValue)))
        #expect(Set(coverage.listSlot.keys) == Set(EntityListSlotID.allCases.map(\.rawValue)))
        #expect(Set(coverage.sectionAction.keys) == Set(SectionActionID.allCases.map(\.rawValue)))
    }

    @Test func everyUnsupportedIdCarriesAReason() {
        let all = [
            coverage.control, coverage.list, coverage.detail, coverage.heroAction, coverage.detailSlot,
            coverage.listSlot, coverage.sectionAction,
        ]
        for statuses in all {
            for case .unsupported(let reason) in statuses.values {
                #expect(!reason.isEmpty)
            }
        }
    }

    /// Native draws no per-renderer list view: a `generic` list renderer prints the text the row
    /// carries at the field's `labelPath`, so a field without one would draw nothing.
    @Test func everyGenericListRendererFieldDeclaresALabelPath() {
        var missing: [String] = []
        for descriptor in EntityCatalog.all {
            for field in descriptor.fields {
                guard let renderer = field.listRenderer,
                    coverage.list[renderer.rawValue] == .generic, field.labelPath == nil
                else { continue }
                missing.append("\(descriptor.key.rawValue).\(field.key) (\(renderer.rawValue))")
            }
        }
        #expect(missing.isEmpty, "\(missing)")
    }

    @Test func serverComposedLabelsResolveFromTheRowTheServerSends() throws {
        let product = try #require(EntityCatalog.all.first { $0.key == .product })
        let expected = try #require(product.fields.first { $0.key == "ledgerExpectedQuantity" })
        let row: JSONValue = ["ledgerExpectedQuantityLabel": "6 +2? −1?"]
        #expect(expected.labelPath == "ledgerExpectedQuantityLabel")
        #expect(row.pathText(try #require(expected.labelPath)) == "6 +2? −1?")

        let meal = try #require(EntityCatalog.all.first { $0.key == .meal })
        let recipes = try #require(meal.fields.first { $0.key == "recipes" })
        let mealRow: JSONValue = [
            "recipes": [["recipe": ["name": "Soup"]], ["recipe": ["name": "Bread"]]]
        ]
        #expect(mealRow.pathText(try #require(recipes.labelPath)) == "Soup, Bread")
    }
}
