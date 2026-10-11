import Foundation
import Testing

@testable import CubbyKit

// Failure modes: credentials reaching an untrusted redirect/frame/origin; malformed bridge
// messages routing a different record; USDA losing its numeric route; cookies from another host;
// a stale/incompatible web bundle being treated as ready; late browser grants reviving logout.
// These tests cover trust policy and credential revision; WebKit lifecycle needs client acceptance.
@Suite("Native workspace trust boundary")
struct NativeWorkspaceTests {
    let base = URL(string: "https://example.invalid")!

    @Test func entryAndBridgeRejectUntrustedOriginsAndMalformedRecords() throws {
        let policy = NativeWorkspacePolicy(baseURL: base)
        #expect(policy.trusts(URL(string: "https://example.invalid:443/product/PRD-4K7M")!))
        #expect(!policy.trusts(URL(string: "https://example.invalid.evil.test")!))
        #expect(!policy.trusts(URL(string: "http://example.invalid")!))
        #expect(!policy.trusts(URL(string: "https://example.invalid:8443")!))
        #expect(!policy.trusts(URL(string: "https://user@example.invalid")!))
        #expect(throws: (any Error).self) {
            try NativeWorkspaceMessage.decode(["version": 2, "type": "ready"])
        }
        #expect(throws: (any Error).self) {
            try NativeWorkspaceMessage.decode([
                "version": 1, "type": "navigate", "entity": "product", "id": "../settings",
            ])
        }
        let message = try NativeWorkspaceMessage.decode([
            "version": 1, "type": "navigate", "entity": "usda-food", "id": "12345",
        ])
        #expect(message.record?.entity == .usdaFood)
        #expect(message.record?.id == "12345")
    }

    @Test func booleanProtocolVersionCannotMasqueradeAsVersionOne() {
        #expect(throws: (any Error).self) {
            try NativeWorkspaceMessage.decode(["version": NSNumber(value: true), "type": "ready"])
        }
    }

    @Test func bootstrapRejectsUntrustedCookiesAndSurfacesRawFailure() throws {
        let policy = NativeWorkspacePolicy(baseURL: base)
        let cookie = try #require(
            HTTPCookie(properties: [
                .domain: "evil.test", .path: "/", .name: "session", .value: "synthetic",
            ]))
        #expect(!policy.accepts(cookie))
        #expect(throws: (any Error).self) {
            try NativeWorkspaceSession.cookies(
                data: Data("raw upstream diagnostic".utf8),
                response: HTTPURLResponse(url: base, statusCode: 500, httpVersion: nil, headerFields: nil)!,
                policy: policy)
        }
    }
    @Test func evidenceEntryCannotExpandToOtherRunViews() {
        let policy = NativeWorkspacePolicy(baseURL: base)
        let entry = policy.evidenceURL(id: "RUN-4K7M")
        #expect(
            entry.absoluteString == "https://example.invalid/RUN-4K7M?nativeWorkspace=run-evidence#evidence")
        #expect(policy.isEvidence(entry, id: "RUN-4K7M"))
        #expect(
            policy.isEvidence(
                URL(string: "https://example.invalid/runs/RUN-4K7M?nativeWorkspace=run-evidence#evidence")!,
                id: "RUN-4K7M"))
        #expect(
            !policy.isEvidence(
                URL(string: "https://example.invalid/RUN-4K7M?nativeWorkspace=run-evidence#overview")!,
                id: "RUN-4K7M"))
        #expect(
            !policy.isEvidence(
                URL(string: "https://example.invalid/RUN-4K7M/other?nativeWorkspace=run-evidence#evidence")!,
                id: "RUN-4K7M"))
    }

    @Test func credentialRevisionDetectsLogoutAndSameTokenSignIn() async throws {
        let provider = CredentialProvider(host: "example.invalid", store: InMemorySessionTokenStore())
        try await provider.set(.bearer("synthetic"))
        let revision = await provider.authenticationRevision()
        await provider.invalidate()
        try await provider.set(.bearer("synthetic"))
        #expect(await provider.authenticationRevision() != revision)
    }

}
