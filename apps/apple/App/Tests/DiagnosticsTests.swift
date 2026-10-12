import CubbyKit
import Foundation
import Sentry
import Testing

@testable import Cubby

@Suite("Test telemetry isolation")
struct DiagnosticsTests {
    @Test func appHostNeverStartsSentry() throws {
        #expect(Diagnostics.isTestHost())
        #expect(!SentrySDK.isEnabled)
        let url = try #require(URL(string: "https://example.com"))
        Diagnostics.start(baseURL: url)
        Diagnostics.report(URLError(.badServerResponse), context: "test.telemetry")
        Diagnostics.setBaseURL(url)
        #expect(!SentrySDK.isEnabled)
    }

    @Test func recognizesTestLaunchMarkers() {
        for key in ["XCTestConfigurationFilePath", "XCTestBundlePath", "XCTestSessionIdentifier"] {
            #expect(Diagnostics.isTestHost([key: "test"]))
        }
        #expect(Diagnostics.isTestHost(["CUBBY_TEST_HOST": "1"]))
        #expect(!Diagnostics.isTestHost([:]))
        #expect(!Diagnostics.isTestHost(["CUBBY_TEST_HOST": "0"]))
    }
}

@MainActor
@Suite("Image diagnostics cancellation")
struct ImageDiagnosticsCancellationTests {
    @Test func cancellingAnExplicitRunAllowsAnotherRequest() {
        let date = Date(timeIntervalSince1970: 1_700_000_000)
        let detail = ImageWithEntity(
            id: ImageCode("IMG-4K7M"), url: "", key: "synthetic-image",
            filename: "sample.jpg", size: 1, contentType: "image/jpeg", status: .uploaded,
            source: .unknown, useOriginal: false, captureAttribution: .none,
            createdAt: date, updatedAt: date, associations: [])
        let client = CubbyClient(
            baseURL: URL(string: "https://example.invalid")!,
            credentials: CredentialProvider(host: "example.invalid", store: InMemorySessionTokenStore()))
        let model = ImageDiagnosticsCompareModel()
        model.run(id: detail.id, detail: detail, client: client)
        #expect(model.loading)

        model.cancel()
        #expect(!model.loading)

        model.run(id: detail.id, detail: detail, client: client)
        #expect(model.loading)
        model.cancel()
    }
}
