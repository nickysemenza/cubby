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
