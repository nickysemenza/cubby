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
    }

    @Test func everyUnsupportedIdCarriesAReason() {
        let all = [
            coverage.control, coverage.list, coverage.detail, coverage.heroAction, coverage.detailSlot,
            coverage.listSlot,
        ]
        for statuses in all {
            for case .unsupported(let reason) in statuses.values {
                #expect(!reason.isEmpty)
            }
        }
    }
}
