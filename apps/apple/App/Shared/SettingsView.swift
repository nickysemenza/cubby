import CubbyKit
import SwiftUI

/// Server and session preferences, presented in a separate Settings scene on macOS.
struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var selectedServer = SettingsServer.production
    @State private var draftURL = ""
    @AppStorage("photoAnalysisWindow") private var photoAnalysisWindowRaw = PhotoAnalysisWindow.thisYear
        .rawValue
    @AppStorage("photoAnalysisPaused") private var photoAnalysisPaused = false
    @State private var photoAnalysisSummary: (analysed: Int, total: Int)?
    #if os(macOS)
        @AppStorage(DockBadge.showInDockDefaultsKey) private var showProblemsInDock = true
    #endif

    var body: some View {
        @Bindable var model = model
        Form {
            Section {
                Picker("Server", selection: serverSelection) {
                    ForEach(SettingsServer.allCases) { server in
                        Text(server.title).tag(server)
                    }
                }
                .accessibilityIdentifier("settings.serverPicker")

                if selectedServer == .custom {
                    TextField("Custom server URL", text: $draftURL)
                        .keyboardDismissBar()
                        .font(.porcelainCode)
                        .autocorrectionDisabled()
                        #if os(iOS)
                            .keyboardType(.URL)
                            .textInputAutocapitalization(.never)
                        #endif
                        .onSubmit(applyCustomServer)
                        .accessibilityIdentifier("settings.customServerURL")
                        .frame(minHeight: PorcelainTokens.touchTarget - 12)

                    if let customURLValidationMessage {
                        Text(customURLValidationMessage)
                            .font(.porcelainLabel)
                            .foregroundStyle(PorcelainTokens.destructive)
                    }

                    if customServerURL != model.baseURL {
                        Button("Use custom server", action: applyCustomServer)
                            .disabled(customServerURL == nil)
                            .accessibilityIdentifier("settings.useCustomServer")
                    }
                }
            } header: {
                Eyebrow("Server")
            } footer: {
                Text(
                    "Each host keeps its own credential, so switching never sends one server's token to another."
                )
                .font(.porcelainLabel)
                .foregroundStyle(PorcelainTokens.graphiteSecondary)
            }

            Section {
                LabeledContent("Host") {
                    Text(CubbyBaseURL.host(of: model.baseURL)).font(.porcelainCode)
                }
                .id(model.baseURL)
                .frame(minHeight: PorcelainTokens.touchTarget - 12)
                LabeledContent("Credential") {
                    Text(model.credentialSummary).font(.porcelainData)
                }
                .frame(minHeight: PorcelainTokens.touchTarget - 12)
                if model.phase == .signedIn {
                    Button("Sign out", role: .destructive) {
                        Task {
                            await model.signOut()
                            dismiss()
                        }
                    }
                    .frame(minHeight: PorcelainTokens.touchTarget - 12)
                }
            } header: {
                Eyebrow("Session")
            }

            if model.phase == .signedIn {
                Section("Utilities") {
                    Button("Developer tools", systemImage: "wrench.and.screwdriver") {
                        model.navigator.openDev()
                        dismiss()
                    }
                    .accessibilityIdentifier("settings.developerTools")
                }
            }

            if model.phase == .signedIn { photosSection }

            #if os(macOS)
                Section {
                    Toggle("Show problem count in Dock", isOn: $showProblemsInDock)
                        .frame(minHeight: PorcelainTokens.touchTarget - 12)
                } header: {
                    Eyebrow("Dock")
                }
            #endif
        }
        .formStyle(.grouped)
        .font(.porcelainBody)
        .porcelainScreen()
        .navigationTitle("Settings")
        .onAppear(perform: synchronizeServerSelection)
        .onChange(of: model.baseURL) { _, _ in synchronizeServerSelection() }
        .photoAnalysisLifecycle(model: model, paused: photoAnalysisPaused) {
            await loadPhotoAnalysisSummary()
        }
        #if os(iOS)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        #endif
        #if os(macOS)
            .onChange(of: showProblemsInDock) { _, enabled in
                if !enabled { DockBadge.clear() }
            }
        #endif
    }

    /// Split out of `body` to keep its expression under the 200ms type-check budget
    /// (apps/apple/AGENTS.md, "Language and style").
    private var photosSection: some View {
        Section {
            Picker("Analysis window", selection: photoAnalysisWindowBinding) {
                ForEach(PhotoAnalysisWindow.allCases) { window in
                    Text(window.title).tag(window)
                }
            }
            LabeledContent("Analysed") { Text(photoAnalysisSummaryText) }
                .frame(minHeight: PorcelainTokens.touchTarget - 12)
            Toggle("Pause analysis", isOn: $photoAnalysisPaused)
                .frame(minHeight: PorcelainTokens.touchTarget - 12)
        } header: {
            Eyebrow("Photos")
        } footer: {
            Text("On-device category classification runs quietly while the Photos tab is open.")
                .font(.porcelainLabel)
                .foregroundStyle(PorcelainTokens.graphiteSecondary)
        }
    }

    private var photoAnalysisWindowBinding: Binding<PhotoAnalysisWindow> {
        Binding(
            get: { PhotoAnalysisWindow(rawValue: photoAnalysisWindowRaw) ?? .thisYear },
            set: { window in
                photoAnalysisWindowRaw = window.rawValue
                model.photoClassificationSweep.setWindow(window)
            })
    }

    private var photoAnalysisSummaryText: String {
        guard let photoAnalysisSummary else { return "…" }
        return "\(photoAnalysisSummary.analysed) of \(photoAnalysisSummary.total)"
    }

    private func loadPhotoAnalysisSummary() async {
        let total = model.photoLibrary.count
        let analysed =
            (try? await model.photoAnalysisStore.classifiedCount(
                newerThan: PhotoClassificationSweep.classifyVersion)) ?? 0
        photoAnalysisSummary = (analysed, total)
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

extension View {
    /// Bundled into one modifier (rather than two more chained calls in `body`) so `SettingsView`'s
    /// `body` stays under the 200ms type-check budget.
    fileprivate func photoAnalysisLifecycle(
        model: AppModel, paused: Bool, loadSummary: @escaping () async -> Void
    ) -> some View {
        task(id: model.photoLibrary.count) { await loadSummary() }
            .onChange(of: paused) { _, paused in model.photoClassificationSweep.setPaused(paused) }
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

#Preview(traits: .modifier(SignedInPreview())) {
    NavigationStack { SettingsView() }
}
