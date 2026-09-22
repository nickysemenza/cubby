import CubbyKit
import Foundation
import Observation
import Photos
import Vision

/// How far back the sweep classifies. Persisted at `@AppStorage("photoAnalysisWindow")` in
/// Settings; `bound(now:)` is nil for `.all` (no lower bound at all).
enum PhotoAnalysisWindow: String, CaseIterable, Identifiable, Sendable {
    case thisYear
    case last12Months
    case all

    var id: Self { self }

    var title: String {
        switch self {
        case .thisYear: "This year"
        case .last12Months: "Last 12 months"
        case .all: "All photos"
        }
    }

    func bound(now: Date = .now, calendar: Calendar = .current) -> Date? {
        switch self {
        case .all:
            return nil
        case .thisYear:
            let year = calendar.dateComponents([.year], from: now)
            return calendar.date(from: year)
        case .last12Months:
            return calendar.date(byAdding: .month, value: -12, to: now)
        }
    }
}

/// Injection seams for the sweep's pause conditions (Q11a): production reads `ProcessInfo`
/// directly, tests substitute a fixed value without needing a real thermal event.
protocol PhotoThermalSource: Sendable {
    var thermalState: ProcessInfo.ThermalState { get }
}
protocol PhotoPowerSource: Sendable {
    var isLowPowerModeEnabled: Bool { get }
}

struct SystemThermalSource: PhotoThermalSource {
    var thermalState: ProcessInfo.ThermalState { ProcessInfo.processInfo.thermalState }
}
struct SystemPowerSource: PhotoPowerSource {
    var isLowPowerModeEnabled: Bool { ProcessInfo.processInfo.isLowPowerModeEnabled }
}

/// Pure ordering/window/skip logic, kept apart from the async runner so it is testable without
/// PhotoKit, Vision, or a real `PhotoAnalysisStore`.
enum PhotoSweepScheduler {
    struct Candidate: Sendable, Hashable {
        let localIdentifier: String
        let creationDate: Date?
        /// The first-of-month bucket this asset's `creationDate` falls in (`.distantPast` for
        /// undated), matching `PhotoLibraryStore.Month.id` — this is what `visibleMonthIDs` names.
        let monthID: Date
    }

    /// Visible-month candidates first (Q4c), then newest→oldest by `creationDate` within each
    /// group (undated sorts last); already-classified ids and anything older than `windowBound`
    /// are dropped entirely rather than merely reordered.
    static func order(
        candidates: [Candidate],
        visibleMonthIDs: Set<Date>,
        windowBound: Date?,
        alreadyClassified: Set<String>
    ) -> [String] {
        candidates
            .filter { candidate in
                guard !alreadyClassified.contains(candidate.localIdentifier) else { return false }
                guard let windowBound, let date = candidate.creationDate else { return true }
                return date >= windowBound
            }
            .sorted { lhs, rhs in
                let lhsVisible = visibleMonthIDs.contains(lhs.monthID)
                let rhsVisible = visibleMonthIDs.contains(rhs.monthID)
                if lhsVisible != rhsVisible { return lhsVisible }
                return (lhs.creationDate ?? .distantPast) > (rhs.creationDate ?? .distantPast)
            }
            .map(\.localIdentifier)
    }
}

/// Classify-only, on-device background sweep (B3): visits every not-yet-classified photo in the
/// current analysis window, visible months first, and records category hits into
/// `PhotoAnalysisStore`. Never touches OCR, feature prints, or the full `PhotoLocalAnalysis` —
/// that only happens when a photo is actually selected for import (`PhotoImportManifest`) or
/// opened in Diagnostics.
@MainActor
@Observable
final class PhotoClassificationSweep {
    /// Bumping this invalidates every prior classification (`PhotoAnalysisStore.ids(in:newerThan:)`
    /// / `classifiedCount(newerThan:)` both filter on it) without a schema migration.
    static let classifyVersion = 1

    struct Outcome: Sendable {
        let categories: [String]
        let topLabels: [PhotoLabelScore]
        let classifyMs: Double
    }

    private(set) var isRunning = false
    private(set) var analysedCount = 0
    private(set) var totalCount = 0
    /// Set on the transition into running, cleared alongside `isRunning`. SwiftUI reads
    /// `currentActivities` on every body evaluation, so a literal `.now` there would make the
    /// Activity screen's relative timestamp perpetually say "now" — this is computed once per run
    /// instead.
    private(set) var startedAt: Date?
    /// The last successfully classified candidate's capture date — the plan's "resume cursor".
    /// Skip logic itself reads the durable `classifyVersion` in the store (survives relaunch on
    /// its own); this is kept for diagnostics/tests, not as the source of truth.
    private(set) var cursor: Date?

    /// Fired on the main actor as each photo finishes, so `PhotoMatchStore.markAnalysis` can
    /// republish that one cell's dot (and, under developer overlays, its timing/label) without the
    /// grid polling the store.
    var onClassified: ((String, PhotoAssetSnapshot) -> Void)?

    @ObservationIgnored private let analysisStore: PhotoAnalysisStore
    @ObservationIgnored private let thermal: any PhotoThermalSource
    @ObservationIgnored private let power: any PhotoPowerSource
    @ObservationIgnored private let candidateProvider: @MainActor () -> [PhotoSweepScheduler.Candidate]
    @ObservationIgnored private let classify:
        @MainActor (PhotoSweepScheduler.Candidate) async throws -> Outcome
    @ObservationIgnored private var isTabActive = false
    @ObservationIgnored private var isSceneActive = true
    @ObservationIgnored private var isPaused: Bool
    /// The master "Automatic work on this device" switch — distinct from `isPaused` (Settings'
    /// temporary "Pause analysis" toggle within library processing).
    @ObservationIgnored private var isParticipating: Bool
    @ObservationIgnored private var window: PhotoAnalysisWindow
    @ObservationIgnored private var visibleMonthIDs: Set<Date> = []
    @ObservationIgnored private var runTask: Task<Void, Never>?
    /// Identifies the in-flight `run()` call. `reconcile(force:)` replaces `runTask` and mints a
    /// new token whenever it force-restarts a run (a window change) while a previous run is still
    /// winding down from cancellation; that previous run's completion handler checks this before
    /// touching `isRunning`/`runTask` so it cannot clobber the state of the run that superseded it.
    @ObservationIgnored private var runGeneration = UUID()
    @ObservationIgnored private var uncoalescedAnalysedCount = 0
    @ObservationIgnored private var lastAnalysedCountBump = Date.distantPast
    // `nonisolated(unsafe)`: `deinit` is not main-actor-isolated, and `NotificationCenter`'s
    // observer tokens are documented safe to pass to `removeObserver` from any thread, so reading
    // this array there (only to unregister, never mutated concurrently) is sound.
    @ObservationIgnored nonisolated(unsafe) private var systemConditionObservers: [NSObjectProtocol] = []

    init(
        analysisStore: PhotoAnalysisStore,
        window: PhotoAnalysisWindow = .thisYear,
        paused: Bool = false,
        isParticipating: Bool = true,
        thermal: any PhotoThermalSource = SystemThermalSource(),
        power: any PhotoPowerSource = SystemPowerSource(),
        candidateProvider: @escaping @MainActor () -> [PhotoSweepScheduler.Candidate],
        classify: @escaping @MainActor (PhotoSweepScheduler.Candidate) async throws -> Outcome
    ) {
        self.analysisStore = analysisStore
        self.window = window
        self.isPaused = paused
        self.isParticipating = isParticipating
        self.thermal = thermal
        self.power = power
        self.candidateProvider = candidateProvider
        self.classify = classify
        observeSystemConditions()
    }

    deinit {
        for observer in systemConditionObservers { NotificationCenter.default.removeObserver(observer) }
    }

    /// Reacts to a thermal/power change mid-run rather than polling for one inside the task
    /// group's child-task loop, which would need `shouldRunNow` (main-actor state) reachable from
    /// a context the task group's body does not statically guarantee is main-actor-isolated.
    /// `reconcile()` on the observer callback both stops an in-flight sweep the moment conditions
    /// worsen and resumes it once they clear, without the sweep polling anything itself.
    private func observeSystemConditions() {
        let thermalToken = NotificationCenter.default.addObserver(
            forName: ProcessInfo.thermalStateDidChangeNotification, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.reconcile() }
        }
        let powerToken = NotificationCenter.default.addObserver(
            forName: .NSProcessInfoPowerStateDidChange, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.reconcile() }
        }
        systemConditionObservers = [thermalToken, powerToken]
    }

    /// Called on Photos-tab appear/disappear (Q4c: runs only while the tab is visible).
    func setActive(_ active: Bool) {
        isTabActive = active
        reconcile()
    }

    /// The Settings "Pause analysis" toggle.
    func setPaused(_ paused: Bool) {
        isPaused = paused
        reconcile()
    }

    /// The master "Automatic work on this device" switch.
    func setParticipating(_ participating: Bool) {
        isParticipating = participating
        reconcile()
    }

    /// The scene phase (foreground/background), separate from tab visibility.
    func setSceneActive(_ active: Bool) {
        isSceneActive = active
        reconcile()
    }

    /// The Settings analysis-window picker.
    func setWindow(_ window: PhotoAnalysisWindow) {
        guard self.window != window else { return }
        self.window = window
        reconcile(force: true)
    }

    /// The browser's `MonthCachingCoordinator` calls this on every visibility change so the next
    /// batch boundary reorders around whatever is on screen now.
    func updateVisibleMonths(_ ids: some Sequence<Date>) {
        visibleMonthIDs = Set(ids)
    }

    static func shouldRun(
        isTabActive: Bool, isSceneActive: Bool, isPaused: Bool, isParticipating: Bool = true,
        thermalState: ProcessInfo.ThermalState, isLowPowerModeEnabled: Bool
    ) -> Bool {
        isTabActive && isSceneActive && !isPaused && isParticipating && !isLowPowerModeEnabled
            && thermalState.rawValue < ProcessInfo.ThermalState.serious.rawValue
    }

    private var shouldRunNow: Bool {
        Self.shouldRun(
            isTabActive: isTabActive, isSceneActive: isSceneActive, isPaused: isPaused,
            isParticipating: isParticipating, thermalState: thermal.thermalState,
            isLowPowerModeEnabled: power.isLowPowerModeEnabled)
    }

    /// Re-evaluates whether the sweep should be running against its current candidate source and
    /// system conditions. Called by every setter above, and by `PhotosRootView` whenever
    /// `PhotoLibraryStore.monthsRevision` changes (a fresh or newly-populated `library.months` —
    /// `run()` reads candidates once at the top of its pass, so nothing else re-checks a candidate
    /// source that changed after a run already started, or after one finished with none to do).
    func reconcile(force: Bool = false) {
        guard shouldRunNow else {
            runTask?.cancel()
            runTask = nil
            isRunning = false
            return
        }
        guard runTask == nil || force else { return }
        runTask?.cancel()
        let token = UUID()
        runGeneration = token
        runTask = Task(priority: .utility) { [weak self] in await self?.run(token: token) }
    }

    private func run(token: UUID) async {
        let all = candidateProvider()
        totalCount = all.count
        let alreadyClassified =
            (try? await analysisStore.classifiedLocalIdentifiers(classifyVersion: Self.classifyVersion)) ?? []
        let ordered = PhotoSweepScheduler.order(
            candidates: all, visibleMonthIDs: visibleMonthIDs, windowBound: window.bound(),
            alreadyClassified: alreadyClassified)
        let candidatesByID = Dictionary(uniqueKeysWithValues: all.map { ($0.localIdentifier, $0) })
        analysedCount = all.count - ordered.count
        uncoalescedAnalysedCount = 0
        lastAnalysedCountBump = .now
        // However this run ends (candidates exhausted, cancelled by `reconcile()`, or simply
        // nothing to do), clear `runTask`/`isRunning` so the *next* `reconcile()` can start a new
        // run — leaving `runTask` set after completion was finding 1's bug: a sweep that started
        // with zero candidates (Photos tab opened before the library finished loading) never ran
        // again once photos appeared, because `reconcile()`'s `guard runTask == nil` never passed.
        // Guarded by `runGeneration` so a run that a force-restart already superseded cannot stomp
        // on the state of the run that replaced it.
        defer {
            if runGeneration == token {
                isRunning = false
                runTask = nil
                startedAt = nil
                if uncoalescedAnalysedCount > 0 { analysedCount += uncoalescedAnalysedCount }
            }
        }
        guard !ordered.isEmpty else { return }
        isRunning = true
        startedAt = .now
        var iterator = ordered.makeIterator()
        // `classify` is a value of a `@MainActor`-isolated function type — Sendable because
        // running it always hops back to this actor regardless of which executor called it — so
        // child tasks can carry it without ever capturing `self` (a non-Sendable class) directly.
        let classifyFn = classify
        await withTaskGroup(of: (PhotoSweepScheduler.Candidate, Outcome?).self) { group in
            var pendingCount = 0
            // Cancellation (from `reconcile()`, triggered by a setter or a thermal/power
            // notification) is the only live gate here — `Task.isCancelled` is a plain,
            // unisolated read, unlike `shouldRunNow` (main-actor state this task-group body is
            // not guaranteed to run on).
            func enqueue() {
                guard !Task.isCancelled, pendingCount < 2, let id = iterator.next(),
                    let candidate = candidatesByID[id]
                else { return }
                pendingCount += 1
                group.addTask {
                    let outcome = try? await classifyFn(candidate)
                    return (candidate, outcome)
                }
            }
            enqueue(); enqueue()
            while let (candidate, outcome) = await group.next() {
                pendingCount -= 1
                if let outcome { await record(candidate, outcome) }
                enqueue()
            }
        }
    }

    private func record(_ candidate: PhotoSweepScheduler.Candidate, _ outcome: Outcome) async {
        do {
            try await analysisStore.upsertClassification(
                localIdentifier: candidate.localIdentifier, categories: outcome.categories,
                topLabels: outcome.topLabels, classifyVersion: Self.classifyVersion,
                classifyMs: outcome.classifyMs)
            // `analysedCount` (and so `statusText`) only publishes at most once per second or per
            // 50 photos, whichever comes first — matching `PhotoMatchStore.classifiedRevision`'s
            // cadence — rather than once per photo, which re-rendered the "Analysing… N of M"
            // caption on every classification in a sweep over thousands of photos.
            uncoalescedAnalysedCount += 1
            let now = Date()
            if uncoalescedAnalysedCount >= 50 || now.timeIntervalSince(lastAnalysedCountBump) >= 1 {
                analysedCount += uncoalescedAnalysedCount
                uncoalescedAnalysedCount = 0
                lastAnalysedCountBump = now
            }
            cursor = candidate.creationDate
            onClassified?(
                candidate.localIdentifier,
                PhotoAssetSnapshot(
                    localIdentifier: candidate.localIdentifier, modificationDate: nil,
                    perceptualHash: nil, hashRevision: 0, categories: outcome.categories,
                    topLabels: outcome.topLabels, classifyVersion: Self.classifyVersion,
                    classifyMs: outcome.classifyMs, classifiedAt: Date(), fullAnalysis: nil,
                    fullAnalysisVersion: nil))
        } catch {
            // A store write failure leaves the photo pending; the next sweep pass retries it.
        }
    }

}

extension PhotoClassificationSweep {
    /// The production wiring: candidates and classification both read through `PhotoLibraryStore`
    /// and `PhotoLibraryIO`, kept out of the type above so its core scheduling logic has no
    /// PhotoKit/Vision dependency to stub in tests.
    convenience init(
        analysisStore: PhotoAnalysisStore, library: PhotoLibraryStore,
        window: PhotoAnalysisWindow = .thisYear, paused: Bool = false, isParticipating: Bool = true
    ) {
        self.init(
            analysisStore: analysisStore, window: window, paused: paused,
            isParticipating: isParticipating,
            candidateProvider: { [weak library] in
                (library?.months ?? []).flatMap { month in
                    month.assets.map {
                        PhotoSweepScheduler.Candidate(
                            localIdentifier: $0.localIdentifier, creationDate: $0.creationDate,
                            monthID: month.id)
                    }
                }
            },
            classify: { [weak library] candidate in
                guard let asset = library?.asset(for: candidate.localIdentifier) else {
                    throw PhotoLibraryFailure.cloudUnavailable
                }
                let start = Date()
                let thumbnail = try await PhotoLibraryIO.shared.classificationThumbnail(for: asset)
                var request = ClassifyImageRequest(.revision2)
                request.cropAndScaleAction = .scaleToFit
                let observations = try await request.perform(on: thumbnail)
                let classifications = observations.map {
                    PhotoClassification(identifier: $0.identifier, confidence: Double($0.confidence))
                }
                let classifyMs = Date().timeIntervalSince(start) * 1000
                return Outcome(
                    categories: PhotoCategoryHit.matchedCategories(for: classifications),
                    topLabels: PhotoCategoryHit.topLabels(for: classifications), classifyMs: classifyMs)
            })
    }
}
