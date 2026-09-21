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

    @Test func stripsHTTPHeadersCookiesAndURLParameters() throws {
        let event = Event(level: .error)
        let request = SentryRequest()
        request.method = "GET"
        request.url = "https://api.example.test/api/v1/images/IMG-EXAMPLE?token=synthetic#private"
        request.queryString = "token=synthetic"
        request.fragment = "private"
        request.bodySize = 123
        request.headers = ["Authorization": "Bearer synthetic", "Accept": "application/json"]
        request.cookies = "session=synthetic"
        event.request = request
        event.context = [
            "response": [
                "status_code": 200,
                "body_size": 456,
                "headers": ["Set-Auth-Token": "synthetic"],
                "cookies": ["session": "synthetic"],
            ],
            "transport": [
                "nested": [
                    "Headers": ["X-Debug": "synthetic"],
                    "Cookies": "synthetic",
                    "attempt": 2,
                ]
            ],
        ]
        event.extra = ["headers": ["X-Extra": "synthetic"], "retry": true]

        let scrubbed = Diagnostics.scrubHTTPMetadata(from: event)

        #expect(scrubbed.request?.method == "GET")
        #expect(scrubbed.request?.url == "https://api.example.test/api/v1/images/IMG-EXAMPLE")
        #expect(scrubbed.request?.bodySize?.intValue == 123)
        #expect(scrubbed.request?.headers == nil)
        #expect(scrubbed.request?.cookies == nil)
        #expect(scrubbed.request?.queryString == nil)
        #expect(scrubbed.request?.fragment == nil)

        let response = try #require(scrubbed.context?["response"])
        #expect(response["status_code"] as? Int == 200)
        #expect(response["body_size"] as? Int == 456)
        #expect(response["headers"] == nil)
        #expect(response["cookies"] == nil)
        let transport = try #require(scrubbed.context?["transport"])
        let nested = try #require(transport["nested"] as? [String: Any])
        #expect(nested["Headers"] == nil)
        #expect(nested["Cookies"] == nil)
        #expect(nested["attempt"] as? Int == 2)
        #expect(scrubbed.extra?["headers"] == nil)
        #expect(scrubbed.extra?["retry"] as? Bool == true)
    }

    @Test func stripsSerializedOpenAPIClientTransportDetails() throws {
        let serializedTransport =
            "request headers: [Authorization: Bearer synthetic], "
            + "response headers: [Set-Auth-Token: synthetic]"
        let event = Event(
            error: NSError(
                domain: "OpenAPIRuntime.ClientError", code: 1,
                userInfo: [NSDebugDescriptionErrorKey: serializedTransport]))
        let exception = Exception(
            value: serializedTransport,
            type: "OpenAPIRuntime.ClientError")
        let mechanism = Mechanism(type: "NSError")
        mechanism.desc = serializedTransport
        mechanism.data = ["headers": ["Set-Auth-Token": "synthetic"]]
        exception.mechanism = mechanism
        event.exceptions = [exception]

        let scrubbed = Diagnostics.scrubHTTPMetadata(from: event)
        let scrubbedException = try #require(scrubbed.exceptions?.first)

        #expect(scrubbed.error?.localizedDescription == "OpenAPI client operation failed")
        #expect(
            scrubbedException.value
                == "OpenAPI client operation failed; transport metadata removed")
        #expect(scrubbedException.mechanism?.desc == nil)
        #expect(scrubbedException.mechanism?.data == nil)
    }
}
