import CoreGraphics
import CubbyKit
import Foundation
import Observation
import Photos

@MainActor
@Observable
final class NearbyReceiptSearchModel {
    struct Candidate: Identifiable {
        let id: String
        let item: PhotoSelectionItem
        let score: NearbyReceiptCandidateScore
        let capturedAt: Date
    }

    enum Phase: Equatable {
        case idle
        case searching(completed: Int, total: Int)
        case results
        case pickerRequired
        case failed
    }

    private(set) var phase: Phase = .idle
    private(set) var candidates: [Candidate] = []
    private(set) var error: String?
    private(set) var isConfirming = false
    private(set) var didConfirm = false
    var selectedID: String?
    private var manualSelection: PhotoSelectionItem?
    @ObservationIgnored private var searchTask: Task<Void, Never>?

    deinit { searchTask?.cancel() }

    var selectedItem: PhotoSelectionItem? {
        if let manualSelection { return manualSelection }
        return candidates.first(where: { $0.id == selectedID })?.item
    }

    func startSearch(
        context: NearbyReceiptSearchContext, analysisStore: PhotoAnalysisStore?
    ) {
        searchTask?.cancel()
        error = nil
        didConfirm = false
        candidates = []
        selectedID = nil
        manualSelection = nil
        searchTask = Task { [weak self] in
            guard let self else { return }
            let authorization = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
            guard !Task.isCancelled else { return }
            guard authorization == .authorized else {
                phase = .pickerRequired
                return
            }
            await search(context: context, analysisStore: analysisStore)
        }
    }

    func receiveManualSelection(_ items: [PhotoSelectionItem]) {
        guard let item = items.first else { return }
        manualSelection = item
        selectedID = item.id
        error = nil
    }

    func confirm(
        context: NearbyReceiptSearchContext,
        submit: @escaping @MainActor @Sendable (PhotoFile, NearbyReceiptSearchContext) async throws -> Void
    ) {
        guard let selectedItem, !isConfirming else { return }
        isConfirming = true
        error = nil
        Task { [weak self] in
            do {
                let file = try await selectedItem.materialize()
                try await submit(file, context)
                guard let self else { return }
                isConfirming = false
                didConfirm = true
            } catch {
                guard let self else { return }
                self.error = error.localizedDescription
                self.isConfirming = false
                Diagnostics.report(error, context: "purchaseImport.receipt.confirm")
            }
        }
    }

    func cancel() {
        searchTask?.cancel()
        searchTask = nil
    }

    private func search(
        context: NearbyReceiptSearchContext, analysisStore: PhotoAnalysisStore?
    ) async {
        let assets = nearbyAssets(for: context)
        phase = .searching(completed: 0, total: assets.count)
        guard !assets.isEmpty else {
            phase = .results
            return
        }
        let snapshots =
            (try? await analysisStore?.snapshots(for: assets.map(\.localIdentifier))) ?? [:]
        var evaluated: [(item: PhotoSelectionItem, signals: NearbyReceiptCandidateSignals)] = []
        let analyzer = LocalPhotoAnalyzer(
            limits: .init(maximumConcurrentImages: 1, maximumAnalysisPixels: 1_024))
        for (offset, asset) in assets.enumerated() {
            guard !Task.isCancelled else { return }
            do {
                let preview = try await PhotoLibraryIO.shared.thumbnail(for: asset, network: false)
                let item = PhotoSelectionItem(asset: asset, preview: preview)
                let analysis: PhotoLocalAnalysis
                if let stored = snapshots[asset.localIdentifier]?.fullAnalysis,
                    let decoded = try? JSONDecoder().decode(PhotoLocalAnalysis.self, from: stored)
                {
                    analysis = decoded
                } else {
                    let file = try await PhotoLibraryIO.shared.file(for: asset, network: false)
                    analysis = try await analyzer.analyze(
                        PhotoAnalysisInput(
                            id: asset.localIdentifier, file: file,
                            provenance: PhotoAnalysisProvenance(
                                source: .photoLibrary, localIdentifier: asset.localIdentifier,
                                filename: file.filename)))
                }
                guard let capturedAt = asset.creationDate else { continue }
                evaluated.append(
                    (
                        item,
                        NearbyReceiptCandidateSignals(
                            id: asset.localIdentifier, capturedAt: capturedAt,
                            classifications: analysis.classifications,
                            recognizedText: analysis.recognizedText)
                    ))
            } catch is CancellationError {
                return
            } catch {
                // An iCloud-only or unsupported photo is not a failed search. The system picker
                // remains available and can explicitly download that asset if the user wants it.
            }
            phase = .searching(completed: offset + 1, total: assets.count)
        }
        let scores = Dictionary(
            uniqueKeysWithValues: NearbyReceiptRanker.rank(
                evaluated.map(\.signals), for: context
            ).map { ($0.id, $0) })
        candidates = evaluated.compactMap { pair in
            guard let score = scores[pair.signals.id], let capturedAt = pair.item.capturedAt else {
                return nil
            }
            guard score.total >= 0.20 else { return nil }
            return Candidate(
                id: pair.signals.id, item: pair.item, score: score, capturedAt: capturedAt)
        }.sorted { lhs, rhs in
            if lhs.score.total != rhs.score.total { return lhs.score.total > rhs.score.total }
            return lhs.capturedAt > rhs.capturedAt
        }
        phase = .results
    }

    private func nearbyAssets(for context: NearbyReceiptSearchContext) -> [PHAsset] {
        let calendar = Calendar.current
        let lower =
            calendar.date(
                byAdding: .day, value: -NearbyReceiptRanker.searchWindowDays,
                to: calendar.startOfDay(for: context.transactionDate)) ?? context.transactionDate
        let upperStart =
            calendar.date(
                byAdding: .day, value: NearbyReceiptRanker.searchWindowDays + 1,
                to: calendar.startOfDay(for: context.transactionDate)) ?? context.transactionDate
        let options = PHFetchOptions()
        options.predicate = NSPredicate(
            format: "creationDate >= %@ AND creationDate < %@", lower as NSDate, upperStart as NSDate)
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        options.fetchLimit = 60
        let result = PHAsset.fetchAssets(with: .image, options: options)
        var assets: [PHAsset] = []
        assets.reserveCapacity(result.count)
        result.enumerateObjects { asset, _, _ in assets.append(asset) }
        return assets
    }
}
