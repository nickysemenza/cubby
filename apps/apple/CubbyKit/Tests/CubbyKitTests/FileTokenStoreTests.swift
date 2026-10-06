import Foundation
import Testing

@testable import CubbyKit

@Suite("FileSessionTokenStore")
struct FileTokenStoreTests {
    private func temporaryStore() -> FileSessionTokenStore {
        // A space in the path: `URL.path()` percent-encodes it, which once broke the permission
        // step on "~/Library/Application Support".
        let dir = FileManager.default.temporaryDirectory.appending(path: "cubby store \(UUID().uuidString)")
        return FileSessionTokenStore(fileURL: dir.appending(path: "credentials.json"))
    }

    @Test func roundTripsPerHostWithOwnerOnlyPermissions() throws {
        let store = temporaryStore()
        #expect(try store.load(for: "a.example") == nil)
        try store.save(.bearer("tok.a"), for: "a.example")
        try store.save(.apiKey("cubby_b"), for: "b.example")
        #expect(try store.load(for: "a.example") == .bearer("tok.a"))
        #expect(try store.load(for: "b.example") == .apiKey("cubby_b"))

        let attributes = try FileManager.default.attributesOfItem(
            atPath: store.fileURL.path(percentEncoded: false))
        #expect((attributes[.posixPermissions] as? Int) == 0o600)

        try store.clear(for: "a.example")
        #expect(try store.load(for: "a.example") == nil)
        #expect(try store.load(for: "b.example") == .apiKey("cubby_b"))
        try? FileManager.default.removeItem(at: store.fileURL.deletingLastPathComponent())
    }

    /// A file in the retired `[host: CubbyCredential]` shape (no longer decoded) must cost one
    /// sign-in, not a dead end where load, save, and clear all throw.
    private func storeWithUndecodableFile() throws -> FileSessionTokenStore {
        let store = temporaryStore()
        try FileManager.default.createDirectory(
            at: store.fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(#"{"old.example":{"bearer":{"_0":"old-token"}}}"#.utf8).write(to: store.fileURL)
        return store
    }

    @Test func anUndecodableFileReadsAsSignedOut() throws {
        let store = try storeWithUndecodableFile()
        #expect(try store.loadState(for: "old.example") == nil)
        try? FileManager.default.removeItem(at: store.fileURL.deletingLastPathComponent())
    }

    @Test func savingOverAnUndecodableFileReplacesItWithTheCurrentFormat() throws {
        let store = try storeWithUndecodableFile()
        try store.save(.bearer("tok.new"), for: "a.example")
        #expect(try store.load(for: "a.example") == .bearer("tok.new"))
        let states = try JSONDecoder().decode(
            [String: CubbyAuthState].self, from: Data(contentsOf: store.fileURL))
        #expect(Array(states.keys) == ["a.example"])
        try? FileManager.default.removeItem(at: store.fileURL.deletingLastPathComponent())
    }

    /// One malformed host in a current-format file must not sign out, or drop, the other hosts.
    @Test func aMalformedHostEntryDropsOnlyThatHost() throws {
        let store = temporaryStore()
        try FileManager.default.createDirectory(
            at: store.fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        let good = String(
            decoding: try JSONEncoder().encode(CubbyAuthState(credential: .bearer("tok.good"))), as: UTF8.self
        )
        let bad = #"{"version":1,"credential":{"bearer":{"_0":"tok.bad"}},"sessionDataCookies":"oops"}"#
        try Data(#"{"good.example":\#(good),"bad.example":\#(bad)}"#.utf8).write(to: store.fileURL)

        #expect(try store.load(for: "good.example") == .bearer("tok.good"))
        #expect(try store.loadState(for: "bad.example") == nil)
        try store.save(.bearer("tok.new"), for: "new.example")
        #expect(try store.load(for: "good.example") == .bearer("tok.good"))
        #expect(try store.load(for: "new.example") == .bearer("tok.new"))
        try? FileManager.default.removeItem(at: store.fileURL.deletingLastPathComponent())
    }

    @Test func clearingAnUndecodableFileRemovesIt() throws {
        let store = try storeWithUndecodableFile()
        try store.clear(for: "old.example")
        #expect(!FileManager.default.fileExists(atPath: store.fileURL.path(percentEncoded: false)))
        #expect(try store.loadState(for: "old.example") == nil)
        try? FileManager.default.removeItem(at: store.fileURL.deletingLastPathComponent())
    }
}
