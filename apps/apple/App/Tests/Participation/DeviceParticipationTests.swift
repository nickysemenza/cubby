import CubbyKit
import Foundation
import Testing

@testable import Cubby

@MainActor
@Suite("DeviceParticipation")
struct DeviceParticipationTests {
    private func defaults() -> UserDefaults {
        let name = "DeviceParticipationTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defaults.removePersistentDomain(forName: name)
        return defaults
    }

    @Test func loadReturnsTheOffUntilAnsweredDefaultWhenNothingIsStored() {
        #expect(
            DeviceParticipation.load(from: defaults())
                == DeviceParticipation(automaticWork: false, answeredAt: nil))
    }

    @Test func saveAndLoadRoundTrip() {
        let store = defaults()
        let answeredAt = Date(timeIntervalSince1970: 1_700_000_000)
        let value = DeviceParticipation(automaticWork: true, answeredAt: answeredAt)
        value.save(to: store)
        let loaded = DeviceParticipation.load(from: store)
        #expect(loaded.automaticWork)
        // Round-tripped through the lenient ISO-8601 transcoder, which loses sub-second precision.
        #expect(abs((loaded.answeredAt ?? .distantPast).timeIntervalSince(answeredAt)) < 1)
    }

    @Test func loadIgnoresCorruptStoredDataAndFallsBackToTheDefault() {
        let store = defaults()
        store.set(Data("not json".utf8), forKey: "cubby.participation")
        #expect(DeviceParticipation.load(from: store) == DeviceParticipation())
    }

    // MARK: - Gate matrix: master on/off × each gate

    /// The gates PR 2 wires the master switch into that are testable without a live PhotoKit
    /// library or companion socket (see `apps/apple/AGENTS.md` — `PhotoLibraryStore`/
    /// `CompanionImageWorker`'s deeper behavior needs a real photo library or socket and is
    /// exercised separately: `CompanionImageWorkerTests` in CubbyKit,
    /// `PhotoClassificationSweepTests`'s end-to-end run below).
    enum Gate: String, CaseIterable {
        /// `PhotoLibraryStore.scanStatus` reads "Automatic matching is off" once the switch is off,
        /// regardless of what the grid itself is doing.
        case photoLibraryScanStatus
        /// `PhotoMatchStore.allowsRepair` — the auto-kick repair download after a matches refresh.
        case photoMatchStoreAllowsRepair
        /// `PhotoClassificationSweep.shouldRun` — the background classification sweep.
        case classificationSweepShouldRun
    }

    @Test(arguments: Gate.allCases, [true, false])
    func gateReflectsTheMasterSwitch(gate: Gate, automaticWork: Bool) {
        switch gate {
        case .photoLibraryScanStatus:
            let library = PhotoLibraryStore()
            #expect(library.isParticipating)
            library.setParticipating(automaticWork)
            #expect(library.isParticipating == automaticWork)
            #expect((library.scanStatus == "Automatic matching is off") == !automaticWork)
        case .photoMatchStoreAllowsRepair:
            let matches = PhotoMatchStore()
            matches.allowsRepair = automaticWork
            #expect(matches.allowsRepair == automaticWork)
        case .classificationSweepShouldRun:
            let runs = PhotoClassificationSweep.shouldRun(
                isTabActive: true, isSceneActive: true, isPaused: false,
                isParticipating: automaticWork, thermalState: .nominal, isLowPowerModeEnabled: false)
            #expect(runs == automaticWork)
        }
    }

    /// Every other pause condition still wins even when participation is on — the master switch
    /// is one more `&&` term, not a replacement for the others.
    @Test func participationOnDoesNotOverridePausedOrThermalOrTabState() {
        #expect(
            !PhotoClassificationSweep.shouldRun(
                isTabActive: true, isSceneActive: true, isPaused: true, isParticipating: true,
                thermalState: .nominal, isLowPowerModeEnabled: false))
        #expect(
            !PhotoClassificationSweep.shouldRun(
                isTabActive: false, isSceneActive: true, isPaused: false, isParticipating: true,
                thermalState: .nominal, isLowPowerModeEnabled: false))
        #expect(
            !PhotoClassificationSweep.shouldRun(
                isTabActive: true, isSceneActive: true, isPaused: false, isParticipating: true,
                thermalState: .serious, isLowPowerModeEnabled: false))
    }
}
