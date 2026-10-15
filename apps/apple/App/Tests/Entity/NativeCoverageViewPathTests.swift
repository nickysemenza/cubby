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
    #if os(macOS)
        @Test func cachedRunListUsesNativeLayoutAndPreservesItsSession() {
            let client = CubbyClient(
                baseURL: URL(string: "https://example.invalid")!,
                credentials: CredentialProvider(
                    host: "example.invalid", store: InMemorySessionTokenStore()))
            let session = NativeBrowserSession(client: client)
            let runs = session.list(for: .run)
            #expect(runs.view == .shelf)
            #expect(session.list(for: .run) === runs)
        }
    #endif

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

    @Test func recordsViewRunsExactlyTheImplementedVerbs() {
        let implemented = ids(SectionActionID.self) {
            SectionActionRunner.coverage(of: SectionActionID(rawValue: $0)!) == .implemented
        }
        #expect(RecordsBlockView.handledVerbs == implemented)
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

    /// The structured renderers have no per-renderer view: they are `generic`, drawn by the one
    /// structured-value editor from the field's declared schema, so a field that declares one
    /// without a schema would silently draw nothing.
    @Test func structuredRenderersAreDrawnFromTheirFieldsSchema() {
        let structured: [ControlRendererID] = [
            .externalIds, .labelNutrition, .sourceAliases, .sourceRefs, .unitMappings,
        ]
        for renderer in structured {
            #expect(NativePresentationCoverage.control(renderer) == .generic)
            #expect(EntityFieldControl.drawing(for: renderer) == nil)
        }
        for descriptor in EntityCatalog.all {
            for field in descriptor.fields where field.controlRenderer.map(structured.contains) == true {
                #expect(field.valueSchema != nil, "\(descriptor.key.rawValue).\(field.key) has no schema")
            }
        }
    }

    @Test func nativeCoverageDecodesAndSurfacesUnsupportedReasons() {
        #expect(NativePresentationCoverage.detailSlot("purchase.receiving") == .implemented)
        #expect(
            NativePresentationCoverage.detailSlot("not.a-slot")
                == .unsupported("Unknown native detail slot."))
    }
}
