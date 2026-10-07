#if os(macOS)
    import Testing

    @testable import CubbyKit

    // An outdated Mac once reported every capture as "The evidence file could not be staged", a
    // retryable failure no retry could fix. A 426 from the version gate is its own outcome.
    @Suite("Browser evidence upload failures")
    struct BrowserUploadFailureTests {
        @Test("A version-gate refusal reports an outdated app, not a staging failure")
        func versionGate() {
            let outdated = ExecutionFailure.uploading(
                CubbyAPIError(
                    status: CubbyAPIError.clientUpdateRequiredStatus, operationID: "upload",
                    detail: nil))
            #expect(outdated.code == BrowserBridgeFailureCode.clientUpdateRequired)
            #expect(!outdated.retryable)

            let staging = ExecutionFailure.uploading(
                CubbyAPIError(status: 503, operationID: "upload", detail: nil))
            #expect(staging.code == BrowserBridgeFailureCode.uploadFailed)
            #expect(staging.retryable)
        }
    }
#endif
