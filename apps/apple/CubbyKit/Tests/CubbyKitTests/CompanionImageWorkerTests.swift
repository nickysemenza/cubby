import Foundation
import Testing

@testable import CubbyKit

@Suite("CompanionImageWorker")
struct CompanionImageWorkerTests {
    @Test func helloUsesTheSuppliedCreationHint() {
        let message = ImageProcessingClientMessage.companionHello(
            deviceID: UUID(), deviceName: "Kitchen phone", foreground: true,
            imageDescriptionAvailable: false, automaticWork: true)
        guard case .hello(let hello) = message else {
            Issue.record("Expected a companion hello")
            return
        }
        #expect(hello.deviceName == "Kitchen phone")
    }

    private func outbox() throws -> CompanionResultOutbox<ImageProcessingResult> {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
            UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return CompanionResultOutbox<ImageProcessingResult>(
            fileURL: directory.appendingPathComponent("outbox.json"))
    }

    private func credentials(bearer: String?) throws -> CredentialProvider {
        let store = InMemorySessionTokenStore()
        if let bearer { try store.save(.bearer(bearer), for: "localhost:3000") }
        return CredentialProvider(host: "localhost:3000", store: store)
    }

    // MARK: - Participation off never opens a socket

    /// `platformAllowsConnection` folds `isParticipating` in, so `reconcileConnection()` returns
    /// before `runConnectionLoop` ever calls `runOneConnection` — the only place a failure (auth or
    /// network) could surface. Contrast with `participatingWorkerAttemptsAConnectionAndSurfacesTheFailure`
    /// below, which proves this suite's failure-observation signal actually fires when a connection
    /// is attempted, so a passing "no failures" here is not vacuous.
    @Test func participationOffNeverAttemptsAConnection() async throws {
        let failures = FailureBox()
        let worker = CompanionImageWorker(
            baseURL: URL(string: "http://localhost:3000")!,
            credentials: try credentials(bearer: "tok"),
            deviceID: UUID(),
            deviceName: "Test phone",
            foreground: true,
            isParticipating: false,
            outbox: try outbox(),
            failureObserver: { error in Task { await failures.record(error) } })
        await worker.start()
        try await Task.sleep(for: .milliseconds(200))
        await worker.stop()
        #expect(await failures.count == 0)
    }

    /// No credential is saved, so `runOneConnection` throws `URLError.userAuthenticationRequired`
    /// before any network I/O — deterministic, and not on `AuthenticatedSocketSupport`'s expected
    /// reconnect-failure allowlist, so it reaches `failureObserver`.
    @Test func participatingWorkerAttemptsAConnectionAndSurfacesTheFailure() async throws {
        let failures = FailureBox()
        let worker = CompanionImageWorker(
            baseURL: URL(string: "http://localhost:3000")!,
            credentials: try credentials(bearer: nil),
            deviceID: UUID(),
            deviceName: "Test phone",
            foreground: true,
            isParticipating: true,
            outbox: try outbox(),
            failureObserver: { error in Task { await failures.record(error) } })
        await worker.start()
        for _ in 0..<100 {
            if await failures.count > 0 { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        await worker.stop()
        #expect(await failures.count > 0)
    }

    // MARK: - helloAck remotePaused → no work accepted

    @Test func remotePausedRejectsWorkAndUnpausedAcceptsIt() {
        #expect(!CompanionWorkAcceptance.acceptsCommand(remotePaused: true))
        #expect(CompanionWorkAcceptance.acceptsCommand(remotePaused: false))
    }

    @Test func activityCarriesRemotePausedForSettingsToShow() {
        let paused = CompanionImageWorkerActivity(phase: .idle, remotePaused: true)
        #expect(paused.remotePaused)
        let notPaused = CompanionImageWorkerActivity(phase: .idle)
        #expect(!notPaused.remotePaused)
    }
}

private actor FailureBox {
    private(set) var count = 0
    func record(_ error: any Error) { count += 1 }
}
