#if os(iOS)
    import Foundation
    import Testing

    @testable import Cubby

    @MainActor
    @Suite("Scanner startup")
    struct ScannerStartupTests {
        @Test func failedStartupKeepsTheDiagnosticUntilRetrySucceeds() {
            let startup = ScannerStartupState()
            let failure = CocoaError(.fileReadNoPermission)
            startup.start { throw failure }
            #expect(startup.error == failure.localizedDescription)
            var retried = false
            startup.start { retried = true }
            #expect(retried)
            #expect(startup.error == nil)
        }
    }
#endif
