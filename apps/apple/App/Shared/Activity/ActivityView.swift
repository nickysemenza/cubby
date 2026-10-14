import CubbyKit
import SwiftUI

/// Activity: what this device is doing now, and the way into the household's Runs and Image
/// jobs. Server work lists through the generic Run and Image job lists; only device-local
/// progress (with Cancel) and the automatic-work switch are this screen's own.
struct ActivityView: View {
    @Environment(AppModel.self) private var appModel

    var body: some View {
        List {
            localExecution
            Section("Household work") {
                NavigationLink(value: Route.entityList(.run)) {
                    Label("Runs", systemImage: "arrow.triangle.2.circlepath")
                }
                NavigationLink(value: Route.entityList(.run, savedView: "attention")) {
                    Label("Runs needing attention", systemImage: "exclamationmark.circle")
                }
                NavigationLink(value: Route.entityList(.imageJob)) {
                    Label("Image jobs", systemImage: "photo.badge.checkmark")
                }
                NavigationLink(value: Route.entityList(.imageJob, savedView: "attention")) {
                    Label("Image jobs needing attention", systemImage: "exclamationmark.circle")
                }
            }
        }
        .navigationTitle("Activity")
        .inspector(
            isPresented: Binding(
                get: { appModel.navigator.selectedActivity != nil },
                set: { if !$0 { appModel.navigator.selectedActivity = nil } }
            )
        ) {
            if let selection = appModel.navigator.selectedActivity {
                ActivitySelectionDetailView(selection: selection)
                    .inspectorColumnWidth(min: 300, ideal: 380, max: 540)
            }
        }
    }

    @ViewBuilder private var localExecution: some View {
        let activities = appModel.backgroundActivity.visibleActivities
        Section {
            if activities.isEmpty {
                ContentUnavailableView(
                    "No device-local work reported", systemImage: "checkmark.circle")
            } else {
                ForEach(activities) { activity in
                    let row = LocalActivityRow(activity: activity) {
                        appModel.backgroundActivity.cancel(id: activity.id)
                    }
                    if case .serverRun(let runID) = activity.link {
                        Button {
                            appModel.navigator.selectedActivity = .serverRun(runID)
                        } label: {
                            row
                        }
                        .buttonStyle(.plain)
                    } else {
                        row
                    }
                }
            }
        } header: {
            Text("This device — now")
        } footer: {
            Toggle("Automatic work on this device", isOn: automaticWorkBinding)
        }
    }

    private var automaticWorkBinding: Binding<Bool> {
        Binding(
            get: { appModel.participation.automaticWork },
            set: { appModel.setParticipation(automaticWork: $0) })
    }
}

struct ActivitySelectionDetailView: View {
    let selection: ActivitySelection

    var body: some View {
        switch selection {
        // A server record is a Run or an Image job; each opens its own generic detail.
        case .serverRun(let id) where id.hasPrefix("IPR-"):
            EntityDetailView(key: .imageJob, id: id).id("imageJob/\(id)")
        case .serverRun(let id): RunConsoleView(runID: id).id(id)
        case .localActivity(let id): LocalActivityDetailView(id: id)
        }
    }
}

private struct LocalActivityRow: View {
    let activity: BackgroundActivity
    let onCancel: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Group {
                if let progress = activity.progress {
                    ProgressView(value: progress)
                } else {
                    ProgressView()
                }
            }
            .frame(width: 22)
            VStack(alignment: .leading, spacing: 4) {
                Text(activity.title).font(.headline)
                if let detail = activity.detail {
                    Text(detail).font(.caption).foregroundStyle(.secondary)
                }
                DateDisplay(date: activity.startedAt).font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
            if activity.isCancellable {
                Button("Cancel", role: .destructive, action: onCancel)
                    .buttonStyle(.borderless)
            }
        }
        .padding(.vertical, 4)
    }
}

/// A device-local `BackgroundActivity`'s own detail, reached from `Route.localActivity` (the
/// bar/sidebar-row tap target, or a resumed local-activity link). Reads the activity fresh by id
/// on every access — once the id is no longer among `BackgroundActivityCenter.activities`, the
/// work is done and the screen shows "Finished" rather than a distinct terminal state.
struct LocalActivityDetailView: View {
    let id: String
    @Environment(AppModel.self) private var appModel

    private var activity: BackgroundActivity? {
        appModel.backgroundActivity.activities.first { $0.id == id }
    }

    var body: some View {
        List {
            if let activity {
                Section {
                    LabeledContent("Task", value: activity.title)
                    if let detail = activity.detail {
                        LabeledContent("Detail", value: detail)
                    }
                    LabeledContent("Started") {
                        DateDisplay(date: activity.startedAt)
                    }
                    if let progress = activity.progress {
                        LabeledContent("Progress") {
                            Text(progress, format: .percent.precision(.fractionLength(0)))
                        }
                        ProgressView(value: progress)
                    } else {
                        ProgressView()
                    }
                }
                if activity.isCancellable {
                    Section {
                        Button("Cancel", role: .destructive) {
                            appModel.backgroundActivity.cancel(id: activity.id)
                        }
                    }
                }
            } else {
                ContentUnavailableView("Finished", systemImage: "checkmark.circle")
            }
        }
        .navigationTitle(activity?.title ?? "Activity")
        #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
        #endif
    }
}

/// Kept outside the `#Preview` macro bodies below: seeding the model inline there made the type
/// checker choke ("failed to produce diagnostic for expression").
private func previewModelWithRunningLocalActivity() -> AppModel {
    let model = PreviewFixtures.signedInModel()
    _ = model.backgroundActivity.begin(
        BackgroundActivity(
            id: "photo-library-scan", kind: .libraryScan, title: "Scanning library",
            phase: .running, progress: 0.41, detail: "41 of 100", startedAt: .now,
            link: .localActivity("photo-library-scan"), isUserInitiated: false, isCancellable: false))
    return model
}

#Preview("Local activity — running") {
    NavigationStack { LocalActivityDetailView(id: "photo-library-scan") }
        .environment(previewModelWithRunningLocalActivity())
}

#Preview("Local activity — finished", traits: .modifier(SignedInPreview())) {
    NavigationStack { LocalActivityDetailView(id: "gone") }
}

func imageSkipReasonText(_ reason: String) -> String {
    switch reason {
    case "no_subject": "Apple found no foreground subject."
    case "unsupported_format": "This image format is unsupported for the operation."
    case "not_suitable":
        "The image was already transparent, or a previous eligibility policy skipped subject lift."
    case "Image is attached only as label evidence":
        "The previous label-only policy skipped subject lift. Queue missing processing to retry."
    default: reason
    }
}
