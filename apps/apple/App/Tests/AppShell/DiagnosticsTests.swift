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

    @MainActor
    @Test func signedInFailureRetainsRawDiagnosticsAndRetriesTheAction() async throws {
        let model = AppModel.preview(signedIn: true, baseURL: URL(string: "https://example.invalid")!)
        let raw =
            #"{"code":"INTERNAL_SERVER_ERROR","message":"Query failed","diagnostics":{"origin":"server","operation":"entity.mutate","stage":"write","causes":[{"name":"PostgresError","message":"SQLSTATE 23505: synthetic duplicate"}]}}"#
        let error = CubbyAPIError.decode(status: 500, operationID: "entity.mutate", body: Data(raw.utf8))
        var attempts = 0
        model.handle(error) { attempts += 1 }

        #expect(model.phase == .signedIn)
        #expect(model.lastError == raw)
        #expect(model.canRetryLastError)
        await model.retryLastError()?.value
        #expect(attempts == 1)
        #expect(model.lastError == nil)
        #expect(!model.canRetryLastError)
        await model.retryLastError()?.value
        #expect(attempts == 1)
    }

    @MainActor
    @Test func signInFailurePreservesTheConfiguredServer() async throws {
        let server = URL(string: "https://cubby.example.invalid:8443")!
        let model = AppModel.preview(signedIn: false, baseURL: server)
        await model.signInWithGoogle { _ in
            throw AuthError.http(status: 503, body: "Synthetic sign-in upstream failure")
        }
        #expect(model.phase == .signedOut)
        #expect(model.baseURL == server)
        #expect(model.lastError == "HTTP 503: Synthetic sign-in upstream failure")
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
            width: nil, height: nil, detectedContentType: nil, sha256: nil, renderStatus: nil,
            storageStatus: nil,
            source: .unknown, sourcePageUrl: nil, sourceAssetUrl: nil, sourceName: nil, useOriginal: false,
            verifiedAt: nil,
            capturedAt: nil, capturedAtOffsetMinutes: nil, captureLocation: nil, capturePlaceName: nil,
            captureDeviceLabel: nil, capturedByPartyId: nil, capturedByName: nil, captureAttribution: .none,
            provenanceEvidence: nil, sourceEvidence: nil,
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
