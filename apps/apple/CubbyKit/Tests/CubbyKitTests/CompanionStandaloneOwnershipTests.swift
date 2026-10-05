import Foundation
import Testing

@testable import CubbyKit

/// A standalone companion (`cubby companion`) owns a host's outbox and a device id on disk.
/// Ways that breaks: two processes sharing one outbox (each rewrites the whole snapshot, so one
/// erases the other's unacknowledged result), a lock that is not released, two first starts minting
/// different device ids, and a damaged id file silently replaced with a new device.
@Suite("Companion standalone ownership")
struct CompanionStandaloneOwnershipTests {
    private func directory() throws -> URL {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
            "companion-ownership-\(UUID())", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }

    @Test func aSecondOwnerOfTheSameLockIsRefusedUntilTheFirstReleases() throws {
        let path = try directory().appendingPathComponent("owner.lock")
        var first: CompanionOwnerLock? = try CompanionOwnerLock.acquire(at: path)
        #expect(throws: CompanionOwnerLock.Failure.self) { try CompanionOwnerLock.acquire(at: path) }
        first?.release()
        first = nil
        _ = try CompanionOwnerLock.acquire(at: path)
    }

    @Test func concurrentFirstStartsAgreeOnOneDeviceID() async throws {
        let path = try directory().appendingPathComponent("device-id")
        let ids = try await withThrowingTaskGroup(of: UUID.self) { group in
            for _ in 0..<32 {
                group.addTask { try CompanionDeviceIdentity.loadOrCreate(at: path) }
            }
            return try await group.reduce(into: Set<UUID>()) { $0.insert($1) }
        }
        #expect(ids.count == 1)
        #expect(try CompanionDeviceIdentity.loadOrCreate(at: path) == ids.first)
    }

    @Test func aDamagedDeviceIDIsAnErrorNotANewDevice() throws {
        let path = try directory().appendingPathComponent("device-id")
        try Data("not-a-uuid".utf8).write(to: path)
        #expect(throws: (any Error).self) { try CompanionDeviceIdentity.loadOrCreate(at: path) }
        #expect(try String(contentsOf: path, encoding: .utf8) == "not-a-uuid")
    }
}
