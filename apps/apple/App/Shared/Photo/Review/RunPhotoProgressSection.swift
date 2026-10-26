import CubbyKit
import SwiftUI

/// A photo-inventory Run's processing: upload and description progress, the lifecycle status,
/// per-photo recovery and the start of grouping. List content, so the Run console places it
/// among its own sections. Reviewing the proposed groups is web's: the console's `photo-batch`
/// slot is a handoff row to `run/<id>#photo-batch`.
struct RunPhotoProgressSection: View {
    let runID: String
    let session: RunConsoleSession

    @Environment(AppModel.self) private var appModel

    var body: some View {
        if let review = session.review {
            Section {
                photoProcessing(review.images)
                if review.lifecycle.processor != nil {
                    lifecycleStatus(review)
                } else if review.review.proposals.isEmpty, let readiness = session.groupingReadiness {
                    Text(readiness.message).foregroundStyle(.secondary)
                    switch readiness {
                    case .readyToStart:
                        Button {
                            Task { await session.startGrouping(runID: runID, client: appModel.client) }
                        } label: {
                            Label("Start grouping", systemImage: "sparkles")
                        }
                        .disabled(session.busy)
                    case .descriptionsMissing(let ids):
                        continueWithoutButton(ids)
                    case .waitingForPhotos, .processing, .working, .needsReviewOnWeb:
                        EmptyView()
                    }
                } else {
                    let proposed = review.review.proposals.filter { $0.state == .proposed }.count
                    if proposed > 0 {
                        Text(
                            "\(proposed) item \(proposed == 1 ? "group is" : "groups are") ready for review.")
                    }
                }
            } header: {
                Text("Photo processing")
            }
        }
    }

    @ViewBuilder private func lifecycleStatus(_ review: PhotoRunReviewResponse) -> some View {
        switch review.lifecycle.phase.rawValue {
        case "waiting_for_upload":
            Text("Waiting for the remaining photos to upload.").foregroundStyle(.secondary)
        case "describing":
            Text(
                "Describing photos · \(review.lifecycle.describedImageCount)/\(review.lifecycle.finalizedImageCount)"
            )
            .foregroundStyle(.secondary)
        case "grouping":
            Label("Grouping photos", systemImage: "sparkles")
        case "ready_for_handoff":
            Text("Photo descriptions are ready for Claude or Codex.")
            Button("Copy agent prompt", systemImage: "doc.on.doc") {
                Clipboard.copy(
                    "Use Cubby MCP to inspect photo import \(runID). Read its photos and descriptions, propose item groups, and leave the groups for member review. Do not create or approve products. Optional device analysis must not delay grouping."
                )
            }
        case "needs_attention":
            Label("Some photos need attention", systemImage: "exclamationmark.triangle")
            if let error = review.lifecycle.dispatchError {
                Text(error).textSelection(.enabled)
            }
            if !review.lifecycle.failedImageIds.isEmpty {
                ForEach(review.images.filter { review.lifecycle.failedImageIds.contains($0.id) }, id: \.id) {
                    image in
                    HStack(alignment: .top) {
                        Thumb(url: URL(string: image.originalUrl), size: 58)
                        VStack(alignment: .leading) {
                            Text(missingDescriptionText(image)).textSelection(.enabled)
                            Button("Retry this photo") {
                                Task {
                                    do {
                                        _ = try await appModel.client.retryImageProcessing(
                                            .init(id: image.id))
                                        await refresh()
                                    } catch { appModel.handle(error) }
                                }
                            }
                            .disabled(session.busy)
                        }
                    }
                }
                continueWithoutButton(review.lifecycle.failedImageIds)
            }
        case "ready_for_review":
            Text("Item groups are ready for review.")
        case "completed":
            Label("Import completed", systemImage: "checkmark.circle")
        default:
            EmptyView()
        }
    }

    private func refresh() async {
        await session.refresh(runID: runID, client: appModel.client)
    }

    /// The server lists failed and skipped descriptions alike in `failedImageIds`; a skip keeps
    /// its own reason wording.
    private func missingDescriptionText(_ image: PhotoRunImage) -> String {
        if image.describe == .skipped {
            return image.describeReason.map(imageSkipReasonText) ?? "Photo description was skipped"
        }
        return image.describeReason ?? "Photo description failed"
    }

    /// Excludes photos whose description failed or was skipped, so grouping continues without them.
    private func continueWithoutButton(_ ids: [ImageCode]) -> some View {
        Button(ids.count == 1 ? "Continue without this photo" : "Continue without these \(ids.count) photos")
        {
            Task {
                do {
                    _ = try await appModel.client.excludeFailedPhotoDescriptions(
                        .init(runId: runID, imageIds: ids))
                    await refresh()
                } catch { appModel.handle(error) }
            }
        }
        .disabled(session.busy || ids.isEmpty)
    }

    private func photoProcessing(_ images: [PhotoRunImage]) -> some View {
        let described = images.filter { $0.describe == .ready || $0.describe == .skipped }.count
        let cutouts = images.filter { $0.cutout == .ready || $0.cutout == .skipped }.count
        let deviceDone = images.filter(\.localAnalysisReady).count
        return VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: FieldGuideTokens.Space.xl) {
                    processingCount("Device · optional", done: deviceDone, total: images.count)
                    processingCount("Description", done: described, total: images.count)
                    processingCount("Lift · optional", done: cutouts, total: images.count)
                }
                VStack(alignment: .leading) {
                    processingCount("Device · optional", done: deviceDone, total: images.count)
                    processingCount("Description", done: described, total: images.count)
                    processingCount("Lift · optional", done: cutouts, total: images.count)
                }
            }
            if !images.isEmpty,
                images.allSatisfy({ $0.describe == .ready }),
                let first = images.compactMap(\.describeStartedAt).min(),
                let last = images.compactMap(\.describeCompletedAt).max()
            {
                Text(
                    "Described \(images.count) photos in \(last.timeIntervalSince(first).formatted(.number.precision(.fractionLength(1)))) seconds"
                )
                .font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private func processingCount(_ title: String, done: Int, total: Int) -> some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
            Text(title).font(.caption2).foregroundStyle(.secondary)
            Text("\(done)/\(total)").font(.subheadline.weight(.semibold)).monospacedDigit()
        }
    }
}
