import Foundation
import Testing

@testable import Cubby

@Suite("Native settings and build metadata")
struct AppBuildMetadataTests {
    @Test func readsStampedMetadataAndBuildsCommitLink() throws {
        let metadata = AppBuildMetadata(
            dictionary: [
                "branch": "codex/native-build-info",
                "commit": "abcdef1",
                "subject": "Show native build identity",
            ])

        #expect(metadata.branch == "codex/native-build-info")
        #expect(metadata.commit == "abcdef1")
        #expect(metadata.subject == "Show native build identity")
        #expect(
            metadata.commitURL
                == URL(string: "https://github.com/nickysemenza/cubby/commit/abcdef1"))
    }

    @Test func missingAndBlankMetadataUseSafeFallbacks() {
        let missing = AppBuildMetadata(dictionary: nil)
        let blank = AppBuildMetadata(
            dictionary: ["branch": " ", "commit": "\n", "subject": ""])

        for metadata in [missing, blank] {
            #expect(metadata.branch == "Unavailable")
            #expect(metadata.commit == "Unavailable")
            #expect(metadata.subject == "Unavailable")
            #expect(metadata.commitURL == nil)
        }
    }

    @Test func missingBundleResourceUsesSafeFallbacks() {
        let metadata = AppBuildMetadata.load(bundle: Bundle(for: MissingResourceSentinel.self))

        #expect(metadata.branch == "Unavailable")
        #expect(metadata.commit == "Unavailable")
        #expect(metadata.subject == "Unavailable")
        #expect(metadata.commitURL == nil)
    }

    @Test(
        arguments: [
            ("https://cubby.nickysemenza.com", SettingsServer.production),
            ("https://cubby.nickysemenza.com/", SettingsServer.production),
            ("http://localhost:3000", SettingsServer.local),
            ("https://staging.example.com", SettingsServer.custom),
        ])
    func classifiesServerPreset(value: String, expected: SettingsServer) throws {
        let url = try #require(URL(string: value))
        #expect(SettingsServer(baseURL: url) == expected)
    }

    @Test(
        arguments: [
            ("https://staging.example.com/api", true),
            (" http://localhost:8787 ", true),
            ("ftp://example.com", false),
            ("https://", false),
            ("example.com", false),
            ("", false),
        ])
    func validatesCustomServerURL(value: String, isValid: Bool) {
        #expect((SettingsServer.customURL(from: value) != nil) == isValid)
        if !value.isEmpty {
            #expect((SettingsServer.customURLValidationMessage(for: value) == nil) == isValid)
        }
    }
}

private final class MissingResourceSentinel {}
