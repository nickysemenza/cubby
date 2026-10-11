import CubbyKit
import SwiftUI
import WebKit

/// The sole hosted pilot. Overview, actions and photo review remain native.
struct RunEvidenceLink: View {
    let runID: String
    @State private var showing = false
    var body: some View {
        Button("Transcript, logs and AI usage", systemImage: "doc.text.magnifyingglass") { showing = true }
            .sheet(isPresented: $showing) {
                NavigationStack { RunEvidenceView(runID: runID) }
            }
    }
}

struct RunEvidenceView: View {
    let runID: String
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var host: RunEvidenceHost?

    var body: some View {
        ZStack {
            if let host {
                RunEvidenceWebView(host: host)
                    .id(ObjectIdentifier(host))
                if let error = host.error {
                    LoadFailureView(title: "Couldn’t load Run evidence", message: error) { start() }
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(FieldGuideTokens.canvas)
                } else if !host.ready {
                    LoadingIndicator.screen(label: "Loading Run evidence")
                        .background(FieldGuideTokens.canvas)
                }
            }
        }
        .navigationTitle("Run evidence")
        #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
        .task(id: "\(model.baseURL)|\(runID)") { start() }
        .onChange(of: model.entityMutationRevision) { _, _ in host?.nativeContextChanged() }
        .onDisappear { host?.stop() }
        #if os(macOS)
            .frame(minWidth: 480, idealWidth: 800, minHeight: 420, idealHeight: 640)
        #endif
    }
    private func start() {
        host?.stop()
        let next = RunEvidenceHost(model: model, runID: runID, externalURL: { openURL($0) }) {
            selection, replace in
            dismiss()
            if replace {
                model.navigator.replaceCurrentRecord(with: selection)
            } else {
                model.navigator.openRecord(selection)
            }
        }
        host = next
        next.retry()
    }

}

@MainActor
final class NativeRunEvidenceContext {
    private var hosts: [ObjectIdentifier: RunEvidenceHost] = [:]
    func register(_ host: RunEvidenceHost) { hosts[ObjectIdentifier(host)] = host }
    func release(_ host: RunEvidenceHost) { hosts[ObjectIdentifier(host)] = nil }
    func reset() {
        let active = Array(hosts.values)
        hosts.removeAll()
        for host in active { host.stop() }
    }
}

@MainActor
@Observable
final class RunEvidenceHost: NSObject, WKNavigationDelegate, WKScriptMessageHandler, WKUIDelegate {
    let webView: WKWebView
    private(set) var ready = false
    private(set) var error: String?
    private let model: AppModel
    private let runID: String
    private let baseURL: URL
    private let credentials: CredentialProvider
    private let policy: NativeWorkspacePolicy
    private let externalURL: (URL) -> Void
    private let navigate: (RecordSelection, Bool) -> Void
    private var task: Task<Void, Never>?
    private var readinessTask: Task<Void, Never>?
    private var credentialRevision: Int?
    private var stopped = false
    private var attempt = UUID()
    private var documentCommitted = false
    private var responseFailureStatus: Int?
    private var mutationRevision: Int

    init(
        model: AppModel, runID: String, externalURL: @escaping (URL) -> Void,
        navigate: @escaping (RecordSelection, Bool) -> Void
    ) {
        self.model = model
        self.runID = runID
        baseURL = model.baseURL
        credentials = model.credentials
        policy = NativeWorkspacePolicy(baseURL: model.baseURL)
        self.externalURL = externalURL
        self.navigate = navigate
        mutationRevision = model.entityMutationRevision
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        webView = WKWebView(frame: .zero, configuration: config)
        super.init()
        webView.navigationDelegate = self
        webView.uiDelegate = self
        config.userContentController.add(self, name: "cubbyWorkspace")
        webView.customUserAgent =
            ClientIdentity.currentApp(
                product: "cubby-apple", installationID: AppInstallationID.current
            ).userAgent
        model.nativeRunEvidence.register(self)
    }

    private var current: Bool {
        !stopped && model.phase == .signedIn && model.baseURL == baseURL && model.credentials === credentials
    }

    private func authorized(_ attempt: UUID) async -> Bool {
        guard current, self.attempt == attempt, let credentialRevision else { return false }
        let revision = await credentials.authenticationRevision()
        guard current, self.attempt == attempt else { return false }
        if revision != credentialRevision { stop(); return false }
        return true
    }

    func retry() {
        guard current else { return }
        task?.cancel()
        readinessTask?.cancel()
        webView.stopLoading()
        attempt = UUID()
        let attempt = attempt
        ready = false
        error = nil
        documentCommitted = false
        responseFailureStatus = nil
        task = Task { [weak self] in
            guard let self else { return }
            credentialRevision = await credentials.authenticationRevision()
            guard await authorized(attempt), !Task.isCancelled, let credentialRevision else { return }
            do {
                // Clear the previous browser identity before bootstrap, including retries.
                let store = webView.configuration.websiteDataStore
                await store.removeData(
                    ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast)
                guard await authorized(attempt), !Task.isCancelled else { return }
                let cookies = try await NativeWorkspaceSession.bootstrap(
                    baseURL: baseURL, credentials: credentials,
                    identity: ClientIdentity.currentApp(
                        product: "cubby-apple", installationID: AppInstallationID.current),
                    observer: model.requestTrace, expectedRevision: credentialRevision)
                guard await authorized(attempt), !Task.isCancelled else { return }
                for cookie in cookies {
                    await store.httpCookieStore.setCookie(cookie)
                    guard await authorized(attempt), !Task.isCancelled else { return }
                }
                webView.load(URLRequest(url: policy.evidenceURL(id: runID)))
                readinessTask = Task { [weak self] in
                    do { try await Task.sleep(for: .seconds(20)) } catch { return }
                    guard let self, await authorized(attempt), !ready else { return }
                    fail(URLError(.timedOut))
                }
            } catch is CancellationError { return } catch {
                guard await authorized(attempt), !Task.isCancelled else { return }
                if case NativeWorkspaceError.bootstrap(401, _) = error {
                    await model.signOut()
                } else if case NativeWorkspaceError.bootstrap(426, _) = error {
                    requireUpdate()
                } else if (error as? URLError)?.code == .userAuthenticationRequired {
                    await model.signOut()
                } else {
                    fail(error)
                }
            }
        }
    }

    func stop() {
        stopped = true
        attempt = UUID()
        task?.cancel()
        readinessTask?.cancel()
        webView.stopLoading()
        webView.navigationDelegate = nil
        webView.uiDelegate = nil
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "cubbyWorkspace")
        webView.loadHTMLString("", baseURL: nil)
        model.nativeRunEvidence.release(self)
        let store = webView.configuration.websiteDataStore
        Task {
            await store.removeData(
                ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast)
        }
    }

    func nativeContextChanged() {
        guard current, mutationRevision != model.entityMutationRevision else { return }
        mutationRevision = model.entityMutationRevision
        let attempt = attempt
        Task { [weak self] in
            guard let self, await authorized(attempt), ready else { return }
            do {
                _ = try await webView.evaluateJavaScript(
                    "window.dispatchEvent(new Event('cubby-workspace-refresh'))")
            } catch {
                guard await authorized(attempt) else { return }
                fail(error)
            }
        }
    }

    private func fail(_ failure: any Error) {
        readinessTask?.cancel()
        ready = false
        error = failure.localizedDescription
        Diagnostics.report(failure, context: "nativeRunEvidence.load")
    }
    private func requireUpdate() {
        readinessTask?.cancel()
        Task { await model.requestTrace.record(operationID: "nativeWorkspace.bridge", ms: 0, status: 426) }
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        let origin = message.frameInfo.securityOrigin
        let defaultPort = baseURL.scheme == "https" ? 443 : 80
        guard current, documentCommitted, responseFailureStatus == nil, message.frameInfo.isMainFrame,
            origin.protocol == baseURL.scheme, origin.host == baseURL.host(),
            (origin.port == 0 ? defaultPort : origin.port) == (baseURL.port ?? defaultPort),
            let url = message.frameInfo.request.url, policy.isEvidenceDocument(url, id: runID),
            let body = message.body as? [String: Any]
        else { return }
        do {
            let event = try NativeWorkspaceMessage.decode(body)
            let attempt = attempt
            Task { [weak self] in
                guard let self, await authorized(attempt) else { return }
                switch event.kind {
                case .ready: ready = true; error = nil; readinessTask?.cancel()
                case .navigate:
                    guard let record = event.record else { return }
                    navigate(.init(key: record.entity, id: record.id), event.replace)
                case .changed:
                    mutationRevision = model.entityMutationRevision + 1
                    model.recordEntityMutation(keys: event.entities ?? Set(EntityKey.allCases))
                case .authRequired: await model.signOut()
                case .updateRequired: requireUpdate()
                }
            }
        } catch {
            let failure = error
            let attempt = attempt
            Task { [weak self] in
                guard let self, await authorized(attempt) else { return }
                if case NativeWorkspaceError.incompatibleBridge = failure {
                    requireUpdate()
                } else {
                    fail(failure)
                }
            }
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async
        -> WKNavigationActionPolicy
    {
        guard await authorized(attempt), let url = action.request.url,
            action.targetFrame?.isMainFrame != false
        else { return .cancel }
        if !policy.trusts(url) {
            if ["https", "http", "mailto", "tel"].contains(url.scheme ?? "") { externalURL(url) }
            return .cancel
        }
        if url.path == "/auth" || url.path.hasPrefix("/auth/") { await model.signOut(); return .cancel }
        if policy.isEvidence(url, id: runID) {
            if action.targetFrame == nil { webView.load(URLRequest(url: url)); return .cancel }
            return .allow
        }
        if case .entity(let entity, let id) = CubbyLink(url: url) {
            navigate(.init(key: entity, id: id), false)
        } else if url.path.hasPrefix("/usda/"), !url.lastPathComponent.isEmpty,
            url.lastPathComponent.allSatisfy({ $0.isASCII && $0.isNumber })
        {
            navigate(.init(key: .usdaFood, id: url.lastPathComponent), false)
        } else {
            fail(
                URLError(
                    .unsupportedURL,
                    userInfo: [
                        NSLocalizedDescriptionKey: "Unexpected Run evidence route: \(url.absoluteString)"
                    ]))
        }
        return .cancel
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse) async
        -> WKNavigationResponsePolicy
    {
        guard await authorized(attempt), response.isForMainFrame,
            let url = response.response.url, policy.isEvidenceDocument(url, id: runID)
        else { return .cancel }
        if let http = response.response as? HTTPURLResponse {
            if http.statusCode == 401 { await model.signOut(); return .cancel }
            if http.statusCode == 426 { requireUpdate(); return .cancel }
            if http.statusCode >= 400 {
                responseFailureStatus = http.statusCode
                ready = false
            }
        }
        return .allow
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard let status = responseFailureStatus else { return }
        let attempt = attempt
        Task { [weak self] in
            guard let self, await authorized(attempt) else { return }
            do {
                let body = try await webView.evaluateJavaScript("document.body.innerText")
                guard await authorized(attempt) else { return }
                fail(NativeWorkspaceError.bootstrap(status, body as? String ?? "Empty response body"))
            } catch {
                guard await authorized(attempt) else { return }
                fail(error)
            }
        }
    }
    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) { documentCommitted = current }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error) {
        if current, (error as NSError).code != NSURLErrorCancelled { fail(error) }
    }
    func webView(
        _ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!,
        withError error: any Error
    ) {
        if current, (error as NSError).code != NSURLErrorCancelled { fail(error) }
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        if current {
            fail(
                URLError(
                    .cannotLoadFromNetwork,
                    userInfo: [
                        NSLocalizedDescriptionKey: "Run evidence web process terminated. Retry to reconnect."
                    ]))
        }
    }
    // The pilot has native confirmations. JavaScript dialogs cannot create an unowned UI flow.
    func webView(
        _ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor @Sendable () -> Void
    ) { completionHandler() }
    func webView(
        _ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor @Sendable (Bool) -> Void
    ) { completionHandler(false) }
    func webView(
        _ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping @MainActor @Sendable (String?) -> Void
    ) { completionHandler(nil) }
}

#if os(iOS)
    private struct RunEvidenceWebView: UIViewRepresentable {
        let host: RunEvidenceHost
        func makeUIView(context: Context) -> WKWebView { host.webView }
        func updateUIView(_ view: WKWebView, context: Context) {}
    }
#else
    private struct RunEvidenceWebView: NSViewRepresentable {
        let host: RunEvidenceHost
        func makeNSView(context: Context) -> WKWebView { host.webView }
        func updateNSView(_ view: WKWebView, context: Context) {}
    }
#endif

#Preview(traits: .modifier(SignedInPreview())) {
    NavigationStack { RunEvidenceView(runID: "RUN-4K7M") }
}
#Preview("Run evidence link") { RunEvidenceLink(runID: "RUN-4K7M") }
