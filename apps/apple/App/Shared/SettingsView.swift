import CubbyKit
import SwiftUI

/// Server and session preferences, presented in a separate Settings scene on macOS.
struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @State private var selectedServer = SettingsServer.production
    @State private var draftURL = ""
    @AppStorage("photoAnalysisWindow") private var photoAnalysisWindowRaw = PhotoAnalysisWindow.thisYear
        .rawValue
    @AppStorage("photoAnalysisPaused") private var photoAnalysisPaused = false
    @State private var photoAnalysisSummary: (analysed: Int, total: Int)?
    @State private var photosReady = false
    @State private var receiptHunts: [ReceiptHuntSummary] = []
    @State private var selectedReceiptHunt: ReceiptHuntSummary?
    /// On iOS Settings is a view-based `NavigationLink` destination. Pushing Dev through the
    /// tab's value path before popping Settings makes SwiftUI animate two independent stacks at
    /// once, which can leave the destination visually blank. Pop first, then append the route
    /// from this view's disappearance callback.
    @State private var opensDeveloperToolsAfterDismissal = false
    #if os(macOS)
        @AppStorage(DockBadge.showInDockDefaultsKey) private var showProblemsInDock = true
        @AppStorage("purchaseImport.browser") private var purchaseImportBrowser = BrowserChoice.chrome
        @AppStorage("purchaseImport.enhancedEvidence") private var enhancedEvidence = false
        @State private var browserPermissions = MacBrowserPermissionSnapshot.current(browser: .chrome)
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
                        #if os(iOS)
                            opensDeveloperToolsAfterDismissal = true
                        #else
                            model.navigator.openDev()
                        #endif
                        dismiss()
                    }
                    .accessibilityIdentifier("settings.developerTools")
                }
            }

            if model.phase == .signedIn, photosReady { photosSection }

            if model.phase == .signedIn, !receiptHunts.isEmpty { receiptHuntsSection }

            #if os(macOS)
                if model.phase == .signedIn { purchaseImportSection }

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
        .onAppear {
            synchronizeServerSelection()
            photosReady = model.photoAnalysisStore != nil
            #if os(macOS)
                browserPermissions = .current(browser: purchaseImportBrowser)
            #endif
        }
        #if os(iOS)
            .onDisappear {
                guard opensDeveloperToolsAfterDismissal else { return }
                opensDeveloperToolsAfterDismissal = false
                model.navigator.openDev()
            }
        #endif
        .onChange(of: model.baseURL) { _, _ in synchronizeServerSelection() }
        .task(id: model.phase) {
            guard model.phase == .signedIn else {
                receiptHunts = []
                return
            }
            await loadReceiptHunts()
        }
        .sheet(item: $selectedReceiptHunt) { hunt in
            if let context = hunt.searchContext {
                NavigationStack {
                    NearbyReceiptSearchView(
                        context: context,
                        onConfirm: { file, context in
                            let submitter = URLSessionConfirmedReceiptImportSubmitter(
                                baseURL: model.baseURL, credentials: model.credentials,
                                client: model.client)
                            try await submitter.submitConfirmedReceipt(
                                ConfirmedReceiptImport(context: context, file: file))
                            await loadReceiptHunts()
                        })
                }
            }
        }
        .photoAnalysisLifecycle(ready: photosReady, model: model, paused: photoAnalysisPaused) {
            await loadPhotoAnalysisSummary()
        }
        #if os(iOS)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        #endif
        #if os(macOS)
            .onChange(of: showProblemsInDock) { _, enabled in
                if !enabled { DockBadge.clear() }
            }
            .onChange(of: purchaseImportBrowser) { _, browser in
                browserPermissions = .current(browser: browser)
                model.browserBridge.reconnect(
                    browser: browser, enhancedEvidence: enhancedEvidence)
            }
            .onChange(of: enhancedEvidence) { _, enabled in
                if enabled { _ = MacBrowserPermissionSnapshot.requestScreenRecording() }
                browserPermissions = .current(browser: purchaseImportBrowser)
                model.browserBridge.reconnect(
                    browser: purchaseImportBrowser, enhancedEvidence: enabled)
            }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active {
                    browserPermissions = .current(browser: purchaseImportBrowser)
                    model.browserBridge.appDidBecomeActive()
                }
            }
        #endif
    }

    #if os(macOS)
        private var purchaseImportSection: some View {
            Section {
                Picker("Browser", selection: $purchaseImportBrowser) {
                    ForEach(BrowserChoice.allCases) { browser in
                        Text(browser.title).tag(browser)
                    }
                }
                .accessibilityIdentifier("settings.purchaseImport.browser")
                LabeledContent("Status") {
                    Text(model.browserBridge.statusLabel)
                        .foregroundStyle(PorcelainTokens.graphiteSecondary)
                }
                Toggle("Enhanced evidence capture", isOn: $enhancedEvidence)
                    .accessibilityIdentifier("settings.purchaseImport.enhancedEvidence")
                if enhancedEvidence {
                    permissionRow(
                        "Screen Recording", status: browserPermissions.screenRecording,
                        pane: .screenRecording)
                }
                permissionRow(
                    "Browser control", status: browserPermissions.appleEvents, pane: .automation)
                Button {
                    model.browserBridge.syncNow(
                        browser: purchaseImportBrowser, enhancedEvidence: enhancedEvidence)
                } label: {
                    if model.browserBridge.isSyncing {
                        Label("Syncing", systemImage: "arrow.triangle.2.circlepath")
                    } else {
                        Label("Sync now", systemImage: "arrow.clockwise")
                    }
                }
                .disabled(!model.browserBridge.isConfigured || model.browserBridge.isSyncing)
                .accessibilityIdentifier("settings.purchaseImport.syncNow")
                if model.browserBridge.status != .connected {
                    Button("Reconnect", systemImage: "arrow.trianglehead.clockwise") {
                        model.browserBridge.reconnect(
                            browser: purchaseImportBrowser, enhancedEvidence: enhancedEvidence)
                    }
                    .disabled(!model.browserBridge.isConfigured || model.browserBridge.isSyncing)
                    .accessibilityIdentifier("settings.purchaseImport.reconnect")
                }
                ForEach(model.browserBridge.accountStates) { account in
                    LabeledContent(account.label) {
                        VStack(alignment: .trailing, spacing: 4) {
                            Text(account.statusLabel)
                                .foregroundStyle(
                                    account.needsAuthentication || account.error != nil
                                        ? PorcelainTokens.destructive : PorcelainTokens.graphiteSecondary)
                            if account.needsAuthentication {
                                Button("Open sign-in") {
                                    model.browserBridge.raiseAuthenticationWindow(accountID: account.id)
                                }
                                .accessibilityIdentifier(
                                    "settings.purchaseImport.openSignIn.\(account.id)")
                            }
                            if let error = account.error {
                                Text(error)
                                    .font(.porcelainLabel)
                                    .foregroundStyle(PorcelainTokens.destructive)
                                    .multilineTextAlignment(.trailing)
                            }
                        }
                    }
                }
                if let error = model.browserBridge.error {
                    Text(error).foregroundStyle(PorcelainTokens.destructive)
                }
            } header: {
                Eyebrow("Purchase imports")
            } footer: {
                Text(
                    "Cubby controls only its own browser window. Page content stays untrusted, and browser sessions never leave this Mac. Enhanced capture falls back to a Cubby-generated PDF when permissions are unavailable."
                )
                .font(.porcelainLabel)
                .foregroundStyle(PorcelainTokens.graphiteSecondary)
            }
        }

        @ViewBuilder
        private func permissionRow(
            _ title: String, status: MacBrowserPermissionStatus, pane: MacBrowserPermissionSnapshot.Pane
        ) -> some View {
            LabeledContent(title) {
                if status == .denied {
                    Button(status.label) { MacBrowserPermissionSnapshot.openSettings(pane) }
                } else {
                    Text(status.label).foregroundStyle(PorcelainTokens.graphiteSecondary)
                }
            }
        }
    #endif

    private var receiptHuntsSection: some View {
        Section {
            ForEach(receiptHunts) { hunt in
                Button {
                    selectedReceiptHunt = hunt
                } label: {
                    HStack {
                        VStack(alignment: .leading) {
                            Text(hunt.merchant ?? "Unidentified purchase")
                            Text(hunt.transactionDate)
                                .font(.porcelainLabel)
                                .foregroundStyle(PorcelainTokens.graphiteSecondary)
                        }
                        Spacer()
                        Text(Double(hunt.amountInCents) / 100, format: .currency(code: "USD"))
                            .font(.porcelainData)
                    }
                }
                .accessibilityIdentifier("settings.purchaseImport.receipt.\(hunt.id)")
            }
        } header: {
            Eyebrow("Receipts needed")
        } footer: {
            Text("Choose a charge to find a nearby receipt photo. Nothing uploads until you confirm it.")
                .font(.porcelainLabel)
                .foregroundStyle(PorcelainTokens.graphiteSecondary)
        }
    }

    @MainActor private func loadReceiptHunts() async {
        do {
            receiptHunts = try await URLSessionReceiptHuntClient(
                baseURL: model.baseURL, credentials: model.credentials
            ).list()
        } catch {
            Diagnostics.report(error, context: "purchaseImport.receiptHunts")
        }
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
        ready: Bool, model: AppModel, paused: Bool, loadSummary: @escaping () async -> Void
    ) -> some View {
        task(id: ready ? model.photoLibrary.count : nil) {
            guard ready else { return }
            await loadSummary()
        }
        .onChange(of: paused) { _, paused in
            guard ready else { return }
            model.photoClassificationSweep?.setPaused(paused)
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

#Preview(traits: .modifier(SignedInPreview())) {
    NavigationStack { SettingsView() }
}
