import CubbyKit
import Foundation
import Synchronization
import Testing

@testable import Cubby

private struct TestFacts: LibraryAssetFacts {
    var localIdentifier: String
    var originalFilename: String? = "IMG_0001.HEIC"
    var creationDate: Date? = Date(timeIntervalSince1970: 1_700_000_000)
    var addedDate: Date? = Date(timeIntervalSince1970: 1_700_000_100)
    var modificationDate: Date? = Date(timeIntervalSince1970: 1_700_000_200)
    var location: LibraryAssetMetadata.Location?
    var sourceType: ImageSightingSourceType = .userLibrary
    var mediaSubtypes: [String] = []
    var hasAdjustments: Bool = false
    var isFavorite: Bool = false
    var pixelWidth: Int = 3024
    var pixelHeight: Int = 4032
    var burstIdentifier: String?
    var camera: LibraryAssetMetadata.Camera?
    var captureTimeZoneOffsetMinutes: Int?
}

private struct StubThermalSource: PhotoThermalSource {
    let state: ProcessInfo.ThermalState
    var thermalState: ProcessInfo.ThermalState { state }
}

private struct StubPowerSource: PhotoPowerSource {
    let lowPower: Bool
    var isLowPowerModeEnabled: Bool { lowPower }
}

@MainActor
@Suite("LibraryMetadataSync")
struct LibraryMetadataSyncTests {
    private func candidate(_ id: String, imageID: String = "IMG-0001") -> LibraryMetadataSync.Candidate {
        LibraryMetadataSync.Candidate(
            localIdentifier: id, imageID: ImageCode(imageID), hashDistance: 1, aspectGate: false)
    }

    private func makeSync(
        analysisStore: PhotoAnalysisStore,
        candidates: [LibraryMetadataSync.Candidate],
        isParticipating: Bool = true,
        isSignedIn: Bool = true,
        thermal: any PhotoThermalSource = StubThermalSource(state: .nominal),
        power: any PhotoPowerSource = StubPowerSource(lowPower: false),
        deviceShortcode: DeviceShortcode? = "DEV-0001",
        send: @escaping @MainActor (ImageSightingCreateInput) async throws -> Void
    ) -> LibraryMetadataSync {
        LibraryMetadataSync(
            analysisStore: analysisStore, host: "cubby.example", installationID: "installation-1",
            isParticipating: isParticipating, isSignedIn: isSignedIn, thermal: thermal, power: power,
            candidateProvider: { candidates },
            factsProvider: { localIdentifier in TestFacts(localIdentifier: localIdentifier) },
            deviceShortcodeProvider: { deviceShortcode },
            send: send)
    }

    // MARK: - Gating

    @Test func shouldRunRequiresEveryGate() {
        #expect(
            LibraryMetadataSync.shouldRun(
                isSceneActive: true, isSignedIn: true, isParticipating: true, thermalState: .nominal,
                isLowPowerModeEnabled: false))
        #expect(
            !LibraryMetadataSync.shouldRun(
                isSceneActive: false, isSignedIn: true, isParticipating: true, thermalState: .nominal,
                isLowPowerModeEnabled: false))
        #expect(
            !LibraryMetadataSync.shouldRun(
                isSceneActive: true, isSignedIn: false, isParticipating: true, thermalState: .nominal,
                isLowPowerModeEnabled: false))
        #expect(
            !LibraryMetadataSync.shouldRun(
                isSceneActive: true, isSignedIn: true, isParticipating: false, thermalState: .nominal,
                isLowPowerModeEnabled: false))
        #expect(
            !LibraryMetadataSync.shouldRun(
                isSceneActive: true, isSignedIn: true, isParticipating: true, thermalState: .serious,
                isLowPowerModeEnabled: false))
        #expect(
            !LibraryMetadataSync.shouldRun(
                isSceneActive: true, isSignedIn: true, isParticipating: true, thermalState: .nominal,
                isLowPowerModeEnabled: true))
    }

    /// Participation off means `reconcile()` never starts a run at all — no send is ever attempted,
    /// not merely throttled.
    @Test func participationOffNeverStartsARun() async throws {
        let store = try PhotoAnalysisStore.make(inMemory: true)
        let sent = Mutex<Int>(0)
        let sync = makeSync(
            analysisStore: store, candidates: [candidate("a"), candidate("b")],
            isParticipating: false,
            send: { _ in sent.withLock { $0 += 1 } })
        sync.reconcile()
        try? await Task.sleep(for: .milliseconds(80))
        #expect(!sync.isRunning)
        #expect(sent.withLock { $0 } == 0)
    }

    /// Same for a signed-out install — sightings need a session to write with.
    @Test func signedOutNeverStartsARun() async throws {
        let store = try PhotoAnalysisStore.make(inMemory: true)
        let sent = Mutex<Int>(0)
        let sync = makeSync(
            analysisStore: store, candidates: [candidate("a")], isSignedIn: false,
            send: { _ in sent.withLock { $0 += 1 } })
        sync.reconcile()
        try? await Task.sleep(for: .milliseconds(80))
        #expect(sent.withLock { $0 } == 0)
    }

    /// No `Device` shortcode yet (the row hasn't registered): the run exits without sending
    /// anything rather than sending a sighting with a garbage `deviceId`.
    @Test func noDeviceShortcodeYetSendsNothing() async throws {
        let store = try PhotoAnalysisStore.make(inMemory: true)
        let sent = Mutex<Int>(0)
        let sync = makeSync(
            analysisStore: store, candidates: [candidate("a")], deviceShortcode: nil,
            send: { _ in sent.withLock { $0 += 1 } })
        sync.reconcile()
        for _ in 0..<50 where sync.isRunning { try await Task.sleep(for: .milliseconds(10)) }
        #expect(sent.withLock { $0 } == 0)
    }

    // MARK: - Concurrency: at most 4 in flight

    @Test func atMostFourSendsRunConcurrently() async throws {
        let store = try PhotoAnalysisStore.make(inMemory: true)
        let candidates = (0..<12).map { candidate("asset-\($0)", imageID: "IMG-\($0)") }
        let inFlight = Mutex<Int>(0)
        let maxObserved = Mutex<Int>(0)
        let sync = makeSync(
            analysisStore: store, candidates: candidates,
            send: { _ in
                let current = inFlight.withLock { count -> Int in
                    count += 1
                    return count
                }
                maxObserved.withLock { $0 = max($0, current) }
                try? await Task.sleep(for: .milliseconds(30))
                inFlight.withLock { $0 -= 1 }
            })
        sync.reconcile()
        for _ in 0..<200 where sync.isRunning { try await Task.sleep(for: .milliseconds(10)) }
        #expect(maxObserved.withLock { $0 } <= 4)
        #expect(maxObserved.withLock { $0 } > 1)
    }

    // MARK: - Cancellation mid-run

    @Test func cancelStopsBeforeEveryCandidateSends() async throws {
        let store = try PhotoAnalysisStore.make(inMemory: true)
        let candidates = (0..<20).map { candidate("asset-\($0)", imageID: "IMG-\($0)") }
        let sentCount = Mutex<Int>(0)
        let sync = makeSync(
            analysisStore: store, candidates: candidates,
            send: { _ in
                sentCount.withLock { $0 += 1 }
                try? await Task.sleep(for: .milliseconds(20))
            })
        sync.reconcile()
        try? await Task.sleep(for: .milliseconds(15))
        sync.cancel()
        #expect(!sync.isRunning)
        let countAtCancel = sentCount.withLock { $0 }
        try? await Task.sleep(for: .milliseconds(200))
        // Cancellation stopped new work from starting; the count does not keep climbing to 20.
        #expect(sentCount.withLock { $0 } < 20)
        #expect(sentCount.withLock { $0 } >= countAtCancel)
    }

    // MARK: - Send-once + resend on modificationDate change

    @Test func aSuccessfulSendMarksTheStoreSoALaterRunSkipsIt() async throws {
        let store = try PhotoAnalysisStore.make(inMemory: true)
        let sentInputs = Mutex<[ImageSightingCreateInput]>([])
        let sync = makeSync(
            analysisStore: store, candidates: [candidate("asset-1", imageID: "IMG-1")],
            send: { input in sentInputs.withLock { $0.append(input) } })
        sync.reconcile()
        for _ in 0..<200 where sync.isRunning { try await Task.sleep(for: .milliseconds(10)) }
        #expect(sentInputs.withLock { $0 }.count == 1)

        let alreadySent = try await store.librarySightingSent(
            host: "cubby.example", localIdentifier: "asset-1", imageId: "IMG-1", version: 1,
            modificationDate: Date(timeIntervalSince1970: 1_700_000_200))
        #expect(alreadySent)

        // A re-plan with the same candidate set must not resend it.
        sync.reconcile()
        for _ in 0..<200 where sync.isRunning { try await Task.sleep(for: .milliseconds(10)) }
        #expect(sentInputs.withLock { $0 }.count == 1)
    }

    // MARK: - Pre-filtering already-sent candidates (A1b)

    /// `totalCount` must reflect only the candidates this pass will actually attempt — a candidate
    /// already recorded for its current `modificationDate` is dropped before `totalCount` is set,
    /// not merely skipped while still counted, or a mostly-synced library reads "0 of N" forever.
    @Test func alreadySentCandidatesAreExcludedFromTheTotal() async throws {
        let store = try PhotoAnalysisStore.make(inMemory: true)
        try await store.markLibrarySightingSent(
            host: "cubby.example", localIdentifier: "asset-a", imageId: "IMG-A", version: 1,
            modificationDate: Date(timeIntervalSince1970: 1_700_000_200), cloudIdentifier: nil)
        let sentInputs = Mutex<[ImageSightingCreateInput]>([])
        let sync = makeSync(
            analysisStore: store,
            candidates: [candidate("asset-a", imageID: "IMG-A"), candidate("asset-b", imageID: "IMG-B")],
            send: { input in sentInputs.withLock { $0.append(input) } })
        sync.reconcile()
        for _ in 0..<200 where sync.isRunning { try await Task.sleep(for: .milliseconds(10)) }
        #expect(sentInputs.withLock { $0 }.map { $0.localIdentifier ?? "" } == ["asset-b"])
        #expect(sync.totalCount == 1)
    }

    // MARK: - Processed vs sent (A1c)

    /// A send failure still finishes the candidate — `processedCount` must reach `totalCount` even
    /// though `sentCount` stays at 0, or the progress bar stalls on every failure instead of
    /// advancing past it.
    @Test func sendFailuresStillAdvanceProgress() async throws {
        let store = try PhotoAnalysisStore.make(inMemory: true)
        let candidates = (0..<5).map { candidate("asset-\($0)", imageID: "IMG-\($0)") }
        let sync = makeSync(
            analysisStore: store, candidates: candidates,
            send: { _ in throw URLError(.badServerResponse) })
        sync.reconcile()
        for _ in 0..<200 where sync.isRunning { try await Task.sleep(for: .milliseconds(10)) }
        #expect(sync.totalCount == 5)
        #expect(sync.processedCount == sync.totalCount)
        #expect(sync.sentCount == 0)
    }

    // MARK: - Replan instead of restart (A1a/A3)

    /// `reconcile()` called mid-run must not cancel the run: the current pass finishes, then
    /// `run(token:)` re-plans exactly once. Every original candidate is sent, and a candidate
    /// appended during the first pass (mirroring `PhotosRootView`'s `matches.revision` observer
    /// firing again mid-scan) is picked up by the replanned pass — never dropped, never resent.
    @Test func reconcileDuringARunFinishesThePassThenReplansOnce() async throws {
        let store = try PhotoAnalysisStore.make(inMemory: true)
        let candidatesBox = Mutex<[LibraryMetadataSync.Candidate]>([
            candidate("asset-0", imageID: "IMG-0"), candidate("asset-1", imageID: "IMG-1"),
        ])
        let sentIdentifiers = Mutex<[String]>([])
        let sync = LibraryMetadataSync(
            analysisStore: store, host: "cubby.example", installationID: "installation-1",
            isParticipating: true, isSignedIn: true,
            thermal: StubThermalSource(state: .nominal), power: StubPowerSource(lowPower: false),
            candidateProvider: { candidatesBox.withLock { $0 } },
            factsProvider: { localIdentifier in TestFacts(localIdentifier: localIdentifier) },
            deviceShortcodeProvider: { "DEV-0001" },
            send: { input in
                sentIdentifiers.withLock { $0.append(input.localIdentifier ?? "") }
                // Holds the first pass open long enough for the test to append a candidate and
                // call `reconcile()` while `runTask` is still in flight.
                try? await Task.sleep(for: .milliseconds(30))
            })
        sync.reconcile()
        try? await Task.sleep(for: .milliseconds(10))
        candidatesBox.withLock { $0.append(candidate("asset-2", imageID: "IMG-2")) }
        sync.reconcile()
        for _ in 0..<300 where sync.isRunning { try await Task.sleep(for: .milliseconds(10)) }
        let sent = sentIdentifiers.withLock { $0 }
        #expect(Set(sent) == Set(["asset-0", "asset-1", "asset-2"]))
        #expect(sent.count == 3)
    }

    // MARK: - Stable startedAt (A1d)

    @Test func startedAtIsStableAcrossReads() async throws {
        let store = try PhotoAnalysisStore.make(inMemory: true)
        let sync = makeSync(
            analysisStore: store, candidates: [candidate("asset-1", imageID: "IMG-1")],
            send: { _ in try? await Task.sleep(for: .milliseconds(30)) })
        #expect(sync.startedAt == nil)
        sync.reconcile()
        let first = sync.startedAt
        #expect(first != nil)
        try? await Task.sleep(for: .milliseconds(5))
        // Re-reading mid-run must return the exact same instant, not a freshly computed `.now`.
        #expect(sync.startedAt == first)
        for _ in 0..<200 where sync.isRunning { try await Task.sleep(for: .milliseconds(10)) }
        #expect(sync.startedAt == nil)
    }

    // MARK: - Sticky cancel (A1e)

    @Test func cancelIsStickyUntilAGateChanges() async throws {
        let store = try PhotoAnalysisStore.make(inMemory: true)
        let sentCount = Mutex<Int>(0)
        let sync = makeSync(
            analysisStore: store, candidates: [candidate("asset-1", imageID: "IMG-1")],
            send: { _ in sentCount.withLock { $0 += 1 } })
        sync.reconcile()
        sync.cancel()
        #expect(!sync.isRunning)

        // A gate change that is not participation or sign-in (a thermal/power notification calling
        // `reconcile()`, exactly as `observeSystemConditions` does) must not undo the cancel.
        sync.reconcile()
        try? await Task.sleep(for: .milliseconds(50))
        #expect(!sync.isRunning)
        #expect(sentCount.withLock { $0 } == 0)

        // Only a participation/sign-in flip clears the sticky cancel.
        sync.setParticipating(true)
        for _ in 0..<200 where sync.isRunning { try await Task.sleep(for: .milliseconds(10)) }
        #expect(sentCount.withLock { $0 } == 1)
    }
}
