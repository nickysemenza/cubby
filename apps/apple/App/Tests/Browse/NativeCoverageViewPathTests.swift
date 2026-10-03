import CubbyKit
import Foundation
import Testing

@testable import Cubby

/// The classification lives in `packages/schemas/src/native-coverage.ts`; these tests hold the
/// App to it. A status of `implemented` must have a native view path, and a view path must not
/// exist for an id the declaration calls unsupported or owned elsewhere (flip the status first).
@Suite("Native coverage view paths")
@MainActor
struct NativeCoverageViewPathTests {
    private func ids<ID: RawRepresentable & CaseIterable>(
        _ type: ID.Type, where predicate: (String) -> Bool
    ) -> Set<ID> where ID.RawValue == String {
        Set(ID.allCases.filter { predicate($0.rawValue) })
    }

    @Test func detailSlotRegistryHandlesExactlyTheImplementedSlots() {
        let implemented = ids(EntityDetailSlotID.self) {
            NativePresentationCoverage.detailSlot($0) == .implemented
        }
        #expect(Set(DetailSlotRegistry.builders.keys) == implemented)
    }

    @Test func listSlotRegistryHandlesExactlyTheImplementedSlots() {
        let implemented = ids(EntityListSlotID.self) {
            NativePresentationCoverage.listSlot($0) == .implemented
        }
        #expect(Set(ListSlotRegistry.builders.keys) == implemented)
    }

    @Test func implementedControlsHaveAControlAndUnsupportedOnesDoNot() {
        for renderer in ControlRendererID.allCases {
            let drawn = EntityFieldControl.drawing(for: renderer) != nil
            switch NativePresentationCoverage.control(renderer) {
            case .implemented: #expect(drawn, "\(renderer.rawValue) is implemented but draws nothing")
            case .ownedElsewhere, .unsupported:
                #expect(!drawn, "\(renderer.rawValue) draws a control but is not implemented")
            case .generic: break  // drawn as the primitive of its controlKind
            }
        }
    }

    @Test func nativeCoverageDecodesAndSurfacesUnsupportedReasons() {
        #expect(
            NativePresentationCoverage.control(.structuredField)
                == .unsupported("Structured fields are available on web."))
        #expect(NativePresentationCoverage.detailSlot("purchase.receiving") == .implemented)
        #expect(
            NativePresentationCoverage.detailSlot("not.a-slot")
                == .unsupported("Unknown native detail slot."))
    }
}
