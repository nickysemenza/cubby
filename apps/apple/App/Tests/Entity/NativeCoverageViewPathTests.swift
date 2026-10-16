import CubbyKit
import Foundation
import Testing

@testable import Cubby

/// The classification lives in `packages/schemas/src/native-coverage.ts`. The generated
/// per-status id enums hold the view registries to it at compile time; these tests cover what
/// the compiler cannot.
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

    @Test func nativeCoverageDecodesAndSurfacesUnsupportedReasons() {
        #expect(NativePresentationCoverage.detailSlot("purchase.receiving") == .implemented)
        #expect(
            NativePresentationCoverage.detailSlot("not.a-slot")
                == .unsupported("Unknown native detail slot."))
    }
}
