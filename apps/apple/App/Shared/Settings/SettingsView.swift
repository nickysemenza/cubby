import CubbyKit
import SwiftUI

#if os(macOS)
    import AppKit
#else
    import UIKit
#endif

/// Settings, in four sections: Server, Notifications, Advanced (this device's automatic work,
/// image-job slots and photo analysis) and About. iPhone pushes it from Today and iPad shows it as
/// a sidebar pane; Mac opens the same sections as panes of its Settings window (`SettingsWindow`).
struct SettingsView: View {
    var isSidebarRoot = false
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    /// On iOS Settings is a view-based `NavigationLink` destination. Pushing Dev through the
    /// tab's value path before popping Settings makes SwiftUI animate two independent stacks at
    /// once, which can leave the destination visually blank. Pop first, then append the route
    /// from this view's disappearance callback.
    @State private var opensDeveloperToolsAfterDismissal = false

    var body: some View {
        Form {
            ServerSettingsSection()
            NotificationSettingsSection()
            if model.phase == .signedIn {
                AdvancedSettingsSection(openDeveloperTools: openDeveloperTools)
                if model.photoAnalysisStore != nil { PhotoAnalysisSettingsSection() }
            }
            AboutSettingsSection()
        }
        .formStyle(.grouped)
        .font(.fieldGuideBody)
        .fieldGuideScreen()
        .navigationTitle("Settings")
        #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            .onDisappear {
                guard opensDeveloperToolsAfterDismissal else { return }
                opensDeveloperToolsAfterDismissal = false
                model.navigator.openDev()
            }
            .toolbar {
                if !isSidebarRoot {
                    ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
                }
            }
        #endif
    }

    private func openDeveloperTools() {
        #if os(iOS)
            if isSidebarRoot {
                model.navigator.openDev()
            } else {
                opensDeveloperToolsAfterDismissal = true
                dismiss()
            }
        #else
            model.navigator.openDev()
        #endif
    }
}

#if os(macOS)
    /// The Mac Settings window (app menu › Settings…, ⌘,), one pane per Settings section. It is a
    /// separate window, so checking a setting never replaces what the main window shows, and it
    /// works before sign-in for server setup.
    struct SettingsWindow: View {
        @Environment(AppModel.self) private var model
        @Environment(\.openWindow) private var openWindow

        var body: some View {
            TabView {
                Tab("Server", systemImage: "server.rack") {
                    pane { ServerSettingsSection() }
                }
                Tab("Notifications", systemImage: "bell.badge") {
                    pane { NotificationSettingsSection() }
                }
                if model.phase == .signedIn {
                    Tab("Advanced", systemImage: "gearshape.2") {
                        pane {
                            AdvancedSettingsSection {
                                model.navigator.openDev()
                                openWindow(id: "main")
                            }
                            if model.photoAnalysisStore != nil { PhotoAnalysisSettingsSection() }
                        }
                    }
                }
                Tab("About", systemImage: "info.circle") {
                    pane { AboutSettingsSection() }
                }
            }
            .frame(width: 540, height: 460)
        }

        private func pane(@ViewBuilder _ content: () -> some View) -> some View {
            Form(content: content)
                .formStyle(.grouped)
                .font(.fieldGuideBody)
        }
    }
#endif

extension View {
    /// iOS rows keep a comfortable touch height; the Mac grouped form uses system row metrics.
    fileprivate func settingsRowHeight() -> some View {
        #if os(iOS)
            frame(minHeight: FieldGuideTokens.touchTarget - 12)
        #else
            self
        #endif
    }
}

/// Server choice, the active host and credential, and Sign out.
private struct ServerSettingsSection: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var selectedServer = SettingsServer.production
    @State private var draftURL = ""

    var body: some View {
        Section {
            Picker("Server", selection: serverSelection) {
                ForEach(SettingsServer.allCases) { server in
                    Text(server.title).tag(server)
                }
            }
            .accessibilityIdentifier("settings.serverPicker")
            .onAppear(perform: synchronizeServerSelection)
            .onChange(of: model.baseURL) { _, _ in synchronizeServerSelection() }

            if selectedServer == .custom {
                TextField("Custom server URL", text: $draftURL)
                    .keyboardDismissBar()
                    .font(.fieldGuideCode)
                    .autocorrectionDisabled()
                    #if os(iOS)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                    #endif
                    .onSubmit(applyCustomServer)
                    .accessibilityIdentifier("settings.customServerURL")
                    .settingsRowHeight()

                if let customURLValidationMessage {
                    Text(customURLValidationMessage)
                        .font(.fieldGuideLabel)
                        .foregroundStyle(FieldGuideTokens.destructive)
                }

                if customServerURL != model.baseURL {
                    Button("Use custom server", action: applyCustomServer)
                        .disabled(customServerURL == nil)
                        .accessibilityIdentifier("settings.useCustomServer")
                }
            }

            LabeledContent("Host") {
                Text(CubbyBaseURL.host(of: model.baseURL)).font(.fieldGuideCode)
            }
            .id(model.baseURL)
            .settingsRowHeight()
            LabeledContent("Credential") {
                Text(model.credentialSummary).font(.fieldGuideData)
            }
            .settingsRowHeight()
            if model.phase == .signedIn {
                Button("Sign out", role: .destructive) {
                    Task {
                        await model.signOut()
                        #if os(iOS)
                            dismiss()
                        #endif
                    }
                }
                .settingsRowHeight()
            }
        } header: {
            Text("Server")
        } footer: {
            Text(
                "Each host keeps its own credential, so switching never sends one server's token to another."
            )
        }
    }

    private var customServerURL: URL? {
        SettingsServer.customURL(from: draftURL)
    }

    private var serverSelection: Binding<SettingsServer> {
        Binding(
            get: { selectedServer },
            set: { server in
                selectedServer = server
                guard let url = server.presetURL else { return }
                draftURL = ""
                model.baseURL = url
            })
    }

    private var customURLValidationMessage: String? {
        SettingsServer.customURLValidationMessage(for: draftURL)
    }

    private func applyCustomServer() {
        guard let url = customServerURL else { return }
        model.baseURL = url
    }

    private func synchronizeServerSelection() {
        let server = SettingsServer(baseURL: model.baseURL)
        selectedServer = server
        if server == .custom { draftURL = model.baseURL.absoluteString }
    }
}

/// This device's share of household work: the master "Automatic work" switch and what it
/// controls, how many image jobs run at once, the temporary "Pause analysis" toggle while photo
/// analysis is ready, and the way into Dev.
private struct AdvancedSettingsSection: View {
    let openDeveloperTools: () -> Void
    @Environment(AppModel.self) private var model
    @AppStorage("photoAnalysisPaused") private var photoAnalysisPaused = false

    var body: some View {
        Section {
            Toggle("Automatic work on this device", isOn: automaticWorkBinding)
                .settingsRowHeight()
                .accessibilityIdentifier("settings.device.automaticWork")
            let worker = model.companionImageActivity
            if worker.remotePaused || worker.phase == .updateRequired {
                LabeledContent("Status") {
                    Text(worker.statusTitle)
                        .foregroundStyle(FieldGuideTokens.destructive)
                }
                .settingsRowHeight()
            }
            ImageWorkConcurrencyRow()
            LabeledContent("Apple image descriptions") {
                Text(FoundationModelsImageDescriber().unavailableReason() ?? "Available")
                    .textSelection(.enabled)
            }
            if model.photoAnalysisStore != nil {
                Toggle("Pause analysis", isOn: pausedBinding)
                    .settingsRowHeight()
            }
            Button("Developer tools", systemImage: "wrench.and.screwdriver", action: openDeveloperTools)
                .accessibilityIdentifier("settings.developerTools")
        } header: {
            Text("Advanced")
        } footer: {
            Text(
                "Automatic work covers companion image jobs, library matching, and background analysis on this device; explicit photo imports always work. Image descriptions and subject lifts share the image job slots, and Automatic uses the value measured for this kind of device."
            )
        }
    }

    private var automaticWorkBinding: Binding<Bool> {
        Binding(
            get: { model.participation.automaticWork },
            set: { model.setParticipation(automaticWork: $0) })
    }

    private var pausedBinding: Binding<Bool> {
        Binding(
            get: { photoAnalysisPaused },
            set: {
                photoAnalysisPaused = $0
                model.photoClassificationSweep?.setPaused($0)
            })
    }
}

/// How many image jobs this device runs at once, one pool shared by descriptions and subject
/// lifts. Stored per device; 0 is Automatic. The worker picks up a change on its next pull.
private struct ImageWorkConcurrencyRow: View {
    @Environment(AppModel.self) private var model
    @AppStorage(CompanionImageConcurrency.defaultsKey) private var stored = 0

    var body: some View {
        Stepper(value: choice, in: 0...CompanionImageConcurrency.range.upperBound) {
            LabeledContent("Image jobs at once") {
                Text(
                    stored == 0
                        ? "Automatic (\(CompanionImageConcurrency.automatic))"
                        : "\(CompanionImageConcurrency.slots(for: stored))"
                )
                .monospacedDigit()
            }
        }
        .settingsRowHeight()
        .accessibilityIdentifier("settings.imageWork.jobs")
    }

    /// Stepping below 1 returns to Automatic (stored 0).
    private var choice: Binding<Int> {
        Binding(
            get: { stored },
            set: {
                stored = $0
                model.applyImageWorkConcurrency()
            })
    }
}

/// The on-device photo analysis window, its progress, and the cache database it lives in. Shown
/// once `AppModel.photoAnalysisStore` is open.
private struct PhotoAnalysisSettingsSection: View {
    @Environment(AppModel.self) private var model
    @AppStorage("photoAnalysisWindow") private var photoAnalysisWindowRaw = PhotoAnalysisWindow.thisYear
        .rawValue
    @State private var photoAnalysisSummary: (analysed: Int, total: Int)?
    @State private var photoStorageSummary: PhotoAnalysisStorageSummary?

    var body: some View {
        Section {
            Picker("Analysis window", selection: photoAnalysisWindowBinding) {
                ForEach(PhotoAnalysisWindow.allCases) { window in
                    Text(window.title).tag(window)
                }
            }
            LabeledContent("Analysed") { Text(photoAnalysisSummaryText) }
                .settingsRowHeight()
                .task(id: model.photoLibrary.count) { await loadPhotoAnalysisSummary() }
            PhotoStorageRows(summary: photoStorageSummary)
        } header: {
            Text("Photo analysis")
        } footer: {
            Text(
                "On-device category classification runs quietly while Photos is open. This database is an on-device cache Cubby can rebuild at any time."
            )
        }
    }

    private var photoAnalysisWindowBinding: Binding<PhotoAnalysisWindow> {
        Binding(
            get: { PhotoAnalysisWindow(rawValue: photoAnalysisWindowRaw) ?? .thisYear },
            set: { window in
                photoAnalysisWindowRaw = window.rawValue
                model.photoClassificationSweep?.setWindow(window)
            })
    }

    private var photoAnalysisSummaryText: String {
        guard let photoAnalysisSummary else { return "…" }
        return "\(photoAnalysisSummary.analysed) of \(photoAnalysisSummary.total)"
    }

    private func loadPhotoAnalysisSummary() async {
        guard let analysisStore = model.photoAnalysisStore else { return }
        let total = model.photoLibrary.count
        let analysed =
            (try? await analysisStore.classifiedCount(
                newerThan: PhotoClassificationSweep.classifyVersion)) ?? 0
        photoAnalysisSummary = (analysed, total)
        do {
            photoStorageSummary = try await analysisStore.storageSummary(
                classifyVersion: PhotoClassificationSweep.classifyVersion)
        } catch {
            Diagnostics.report(error, context: "settings.photoStorage")
        }
    }
}

/// The installed version and build, the TestFlight update while the server refuses this build's
/// writes (the same latch as `UpdateAvailableBanner`), and the web app on the selected server.
private struct AboutSettingsSection: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Section("About") {
            LabeledContent("Version") {
                Text(Self.version).monospacedDigit().textSelection(.enabled)
            }
            .settingsRowHeight()
            if model.requestTrace.clientUpdateRequired {
                LabeledContent("Update") {
                    Text("Required to save changes").foregroundStyle(FieldGuideTokens.destructive)
                }
                .settingsRowHeight()
                OpenTestFlightButton()
            }
            Link(destination: model.webHandoff.url(.route(path: "/"))) {
                Label("Open Cubby on the web", systemImage: "arrow.up.forward.app")
            }
            .accessibilityIdentifier("settings.openOnWeb")
        }
    }

    /// `MARKETING_VERSION (CURRENT_PROJECT_VERSION)`, the pair TestFlight lists for a build.
    static var version: String {
        let info = Bundle.main.infoDictionary ?? [:]
        let version = info["CFBundleShortVersionString"] as? String ?? "0"
        let build = info["CFBundleVersion"] as? String ?? "0"
        return "\(version) (\(build))"
    }
}

/// The "Database" / "Size" / "Rows" rows under Settings › Photo analysis, plus the platform reveal action.
/// Takes a plain value rather than reading `AppModel` directly, so it renders in a `#Preview`
/// without opening a real on-disk `PhotoAnalysisStore`.
private struct PhotoStorageRows: View {
    let summary: PhotoAnalysisStorageSummary?

    var body: some View {
        if let summary, let url = summary.url {
            LabeledContent("Database") {
                VStack(alignment: .trailing, spacing: 2) {
                    Text(url.lastPathComponent)
                    Text(url.path(percentEncoded: false))
                        .font(.fieldGuideCode)
                        .foregroundStyle(FieldGuideTokens.graphiteSecondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .textSelection(.enabled)
                }
            }
            .settingsRowHeight()
            LabeledContent("Size") {
                Text(summary.bytesOnDisk, format: .byteCount(style: .file))
            }
            .settingsRowHeight()
            LabeledContent("Rows") {
                Text(
                    "\(summary.hashedCount.formatted()) hashed · \(summary.classifiedCount.formatted()) classified · \(summary.syncedSightingCount.formatted()) synced"
                )
            }
            .settingsRowHeight()
            #if os(macOS)
                Button("Show in Finder") {
                    NSWorkspace.shared.activateFileViewerSelecting([url])
                }
            #else
                Button("Copy path") {
                    UIPasteboard.general.string = url.path(percentEncoded: false)
                }
            #endif
        } else {
            LabeledContent("Database") { Text("…") }
                .settingsRowHeight()
        }
    }
}

enum SettingsServer: String, CaseIterable, Identifiable {
    case production
    case local
    case custom

    var id: Self { self }

    var title: String {
        switch self {
        case .production: "Production"
        case .local: "Local dev server"
        case .custom: "Custom"
        }
    }

    var presetURL: URL? {
        switch self {
        case .production: AppModel.productionBaseURL
        case .local: AppModel.localBaseURL
        case .custom: nil
        }
    }

    init(baseURL: URL) {
        if Self.sameServer(baseURL, AppModel.productionBaseURL) {
            self = .production
        } else if Self.sameServer(baseURL, AppModel.localBaseURL) {
            self = .local
        } else {
            self = .custom
        }
    }

    static func customURL(from value: String) -> URL? {
        let value = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let components = URLComponents(string: value),
            let scheme = components.scheme?.lowercased(),
            scheme == "http" || scheme == "https",
            components.host?.isEmpty == false
        else {
            return nil
        }
        return components.url
    }

    static func customURLValidationMessage(for value: String) -> String? {
        let value = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return nil }
        guard let components = URLComponents(string: value), let scheme = components.scheme else {
            return "Enter a full http:// or https:// URL."
        }
        guard scheme.lowercased() == "http" || scheme.lowercased() == "https" else {
            return "Use an http:// or https:// URL."
        }
        guard components.host?.isEmpty == false else { return "Enter a URL with a host." }
        return nil
    }

    private static func sameServer(_ lhs: URL, _ rhs: URL) -> Bool {
        guard let left = URLComponents(url: lhs, resolvingAgainstBaseURL: false),
            let right = URLComponents(url: rhs, resolvingAgainstBaseURL: false)
        else {
            return lhs == rhs
        }
        let leftPath = left.path == "/" ? "" : left.path
        let rightPath = right.path == "/" ? "" : right.path
        return left.scheme?.lowercased() == right.scheme?.lowercased()
            && left.host?.lowercased() == right.host?.lowercased()
            && left.port == right.port
            && leftPath == rightPath
            && left.query == right.query
    }
}

extension AppModel {
    /// One phrase for "what are we authenticating with", shown on Today and in Settings.
    var credentialSummary: String {
        switch credential {
        case .bearer(let token): "Session token (\(token.prefix(6))…)"
        case .apiKey: "API key"
        case nil: "None"
        }
    }
}

#Preview("Advanced", traits: .modifier(SignedInPreview())) {
    Form { AdvancedSettingsSection {} }
        .formStyle(.grouped)
}

#Preview("Advanced — automatic work on") {
    let model = PreviewFixtures.signedInModel()
    model.setParticipation(automaticWork: true)
    return Form { AdvancedSettingsSection {} }
        .formStyle(.grouped)
        .environment(model)
}

#Preview("About", traits: .modifier(SignedInPreview())) {
    Form { AboutSettingsSection() }
        .formStyle(.grouped)
}

#if os(macOS)
    #Preview("Mac Settings window", traits: .modifier(SignedInPreview())) {
        SettingsWindow()
    }
#endif

#Preview(traits: .modifier(SignedInPreview())) {
    NavigationStack { SettingsView() }
}

#Preview("Photos — storage") {
    Form {
        PhotoStorageRows(
            summary: PhotoAnalysisStorageSummary(
                url: URL(
                    fileURLWithPath: "/Users/preview/Library/Application Support/Cubby/PhotoAnalysis.sqlite"),
                bytesOnDisk: 18_874_368, rowCount: 4200, hashedCount: 4200, classifiedCount: 3980,
                syncedSightingCount: 1250))
    }
    .formStyle(.grouped)
}
