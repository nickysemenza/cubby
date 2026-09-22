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

        // A forced re-plan with the same candidate set must not resend it.
        sync.reconcile(force: true)
        for _ in 0..<200 where sync.isRunning { try await Task.sleep(for: .milliseconds(10)) }
        #expect(sentInputs.withLock { $0 }.count == 1)
    }
}
