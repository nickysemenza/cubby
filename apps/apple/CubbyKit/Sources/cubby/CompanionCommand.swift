import ArgumentParser
import CubbyKit
import Foundation

#if canImport(Darwin)
    import Darwin
#endif

/// The app's image-processing companion worker, run headless: the same `CompanionImageWorker`,
/// executor, and durable outbox, under the CLI's own device identity and outbox namespace.
struct CompanionCommand: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "companion",
        abstract: "Run as an image-processing companion device (describe_image, subject_lift).",
        discussion: """
            Connects to the companion socket with the stored `auth login` session, executes the jobs \
            the server dispatches, and posts their results. Prints one line per job and each worker \
            phase change. One process serves a host at a time. SIGINT/SIGTERM waits up to \
            \(Int(stopGrace.components.seconds))s for outstanding jobs and result \
            acknowledgements, then stops; a second signal stops at once.
            """
    )

    /// Bounded so launchd's SIGTERM → SIGKILL window (20s by default) is never the one that ends us.
    static let stopGrace: Duration = .seconds(10)

    @OptionGroup var global: GlobalOptions
    @Flag(
        help: """
            Exit after the worker has been connected with no outstanding job (queued, running, or \
            recording) and no unacknowledged result for --idle-seconds; exit 1 if any job failed or the socket never connected \
            within --connect-timeout.
            """)
    var once = false
    @Option(name: .customLong("idle-seconds"), help: "--once quiet window in seconds.")
    var idleSeconds: Int = 10
    @Option(
        name: .customLong("connect-timeout"),
        help: "--once: seconds disconnected (at start or after a drop) before giving up.")
    var connectTimeoutSeconds: Int = 30
    @Flag(help: "Also print socket errors, job ids on each processing phase, and drain-state changes.")
    var verbose = false

    private enum Event: Sendable {
        case activity(CompanionImageWorkerActivity)
        case job(CompanionImageJobReport)
        case failure(String)
        case tick
        case signal(Int32)
    }

    func run() async throws {
        try await CLI.run {
            guard idleSeconds > 0, connectTimeoutSeconds > 0 else {
                throw CLIError.message("--idle-seconds and --connect-timeout must be positive.")
            }
            guard global.apiKey == nil else {
                throw CLIError.message(
                    "The companion socket needs a session; an API key cannot open it. Run `cubby auth login`."
                )
            }
            let context = try CLIContext.make(from: global)
            guard case .bearer = await context.credentials.current() else {
                throw CLIError.message("Not signed in to \(context.host). Run `cubby auth login`.")
            }
            try await work(context)
        }
    }

    private func work(_ context: CLIContext) async throws {
        // Namespaced apart from the app's outbox so neither replays the other device's results, and
        // owned by one CLI process per host so overlapping runs cannot overwrite each other's.
        // The lock keys on the outbox's canonical file, which sanitizes and truncates the namespace.
        let outboxURL = try CompanionResultOutbox<ImageProcessingResult>.applicationSupportFileURL(
            namespace: "cubby-cli-\(context.host)")
        let lock: CompanionOwnerLock
        do {
            lock = try CompanionOwnerLock.acquire(guarding: outboxURL)
        } catch let failure as CompanionOwnerLock.Failure {
            throw CLIError.message(
                "Another `cubby companion` already serves \(context.host) (\(failure)); stop it first.")
        }
        defer { lock.release() }
        let outbox = CompanionResultOutbox<ImageProcessingResult>(fileURL: outboxURL)
        // The CLI is its own device: the app keeps its id in a data-protection Keychain item under
        // its signed team identity, which the ad-hoc-signed CLI cannot read, and sharing one id
        // would make the server treat the app's and the CLI's sockets as one device.
        let deviceID = try CompanionDeviceIdentity.loadOrCreate(
            at: URL.applicationSupportDirectory.appending(path: "Cubby/companion-device-id"))
        let deviceName = "\(ProcessInfo.processInfo.hostName) (cubby CLI)"

        log(
            "device \(deviceID.uuidString.lowercased()) \"\(deviceName)\" → \(context.baseURL.absoluteString)"
        )
        if let reason = FoundationModelsImageDescriber().unavailableReason() {
            log("describe_image: unavailable — \(reason); hello advertises actualImageDescription=false")
        } else {
            log("describe_image: available (SystemLanguageModel.default with .vision)")
        }

        let (events, continuation) = AsyncStream<Event>.makeStream()
        let worker = CompanionImageWorker(
            baseURL: context.baseURL, credentials: context.credentials, deviceID: deviceID,
            deviceName: deviceName, foreground: true, outbox: outbox,
            failureObserver: { continuation.yield(.failure(String(describing: $0))) },
            activityObserver: { continuation.yield(.activity($0)) },
            jobObserver: { continuation.yield(.job($0)) })

        let signalQueue = DispatchQueue(label: "cubby.companion.signals")
        let signalSources = [SIGINT, SIGTERM].map { number in
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: signalQueue)
            source.setEventHandler { continuation.yield(.signal(number)) }
            source.resume()
            return source
        }
        let ticker = Task {
            while !Task.isCancelled {
                continuation.yield(.tick)
                try? await Task.sleep(for: .seconds(1))
            }
        }
        defer {
            ticker.cancel()
            signalSources.forEach { $0.cancel() }
        }

        var policy = CompanionDrainPolicy(
            idleWindow: .seconds(idleSeconds), connectTimeout: .seconds(connectTimeoutSeconds),
            startedAt: .now)
        var lastActivity: CompanionImageWorkerActivity?
        var lastState: CompanionDrainState?
        var stopDeadline: ContinuousClock.Instant?
        var outcome: Ending = .stopped

        await worker.start()
        loop: for await event in events {
            switch event {
            case .activity(let activity):
                report(activity, after: lastActivity)
                lastActivity = activity
            case .job(let job):
                log(Self.line(for: job))
                policy.observeJobFinished(job.status, at: .now)
            case .failure(let message):
                if verbose { log("socket error: \(message)", toStandardError: true) }
            case .tick:
                break
            case .signal(let number):
                guard stopDeadline == nil else {
                    log("signal \(number) again: stopping now")
                    break loop
                }
                log("signal \(number): finishing outstanding jobs (up to \(Self.stopGrace))")
                stopDeadline = .now + Self.stopGrace
                await worker.stopAccepting()
            }

            // Advisory state for the quiet window and logs; the exit itself is gated below on
            // `pauseAcceptingIfSettled()`, which closes acceptance before it checks.
            let state = try await worker.drainState()
            let now = ContinuousClock.now
            if verbose, state != lastState {
                log(
                    "state: connected=\(state.connected) outstanding=\(state.outstandingCommands) "
                        + "unacknowledged=\(state.pendingResults)")
            }
            lastState = state
            policy.observe(state, at: now)

            if let stopDeadline {
                if now >= stopDeadline { break loop }
                if state.isSettled, try await worker.pauseAcceptingIfSettled() { break loop }
            } else if once {
                switch policy.decision(at: now) {
                case .keepRunning: continue
                case .drained:
                    // `false`: something started or is unacknowledged; acceptance reopened and the
                    // next state read restarts the quiet window.
                    guard try await worker.pauseAcceptingIfSettled() else { continue }
                    outcome = .drained
                    break loop
                case .unreachable:
                    outcome = .unreachable
                    break loop
                }
            }
        }

        await worker.stop()
        let left = try await outbox.pending().count
        if left > 0 { log("\(left) result(s) stay in the outbox and replay on the next connection") }
        switch outcome {
        case .stopped: return
        case .drained:
            log(
                "drained: quiet for \(idleSeconds)s; \(policy.failedJobs) failed job(s)"
                    + (lastActivity?.remotePaused == true ? "; this device is paused from the web" : ""))
            if policy.failedJobs > 0 { throw ExitCode.failure }
        case .unreachable:
            throw CLIError.message("No companion connection within \(connectTimeoutSeconds)s.")
        }
    }

    private enum Ending { case stopped, drained, unreachable }

    private func report(
        _ activity: CompanionImageWorkerActivity, after previous: CompanionImageWorkerActivity?
    ) {
        let changed = activity.phase != previous?.phase || activity.remotePaused != previous?.remotePaused
        let jobChanged = activity.jobID != previous?.jobID
        guard changed || (verbose && jobChanged) else { return }
        var line = "phase: \(activity.phase)"
        if activity.remotePaused { line += " (paused from the web: no work is accepted)" }
        if verbose, let kind = activity.kind, let job = activity.jobID { line += " \(kind) job \(job)" }
        log(line)
    }

    private static func line(for job: CompanionImageJobReport) -> String {
        var line = "job \(job.kind) \(job.jobID) \(job.status.rawValue)"
        if let reason = job.reason {
            line += " reason=\(reason)"
            if let retryable = job.retryable { line += retryable ? " retryable" : " final" }
        }
        return line + " "
            + job.duration.formatted(.units(allowed: [.seconds], fractionalPart: .show(length: 2)))
    }

    private func log(_ message: String, toStandardError: Bool = false) {
        let line = "\(Date.now.formatted(.iso8601.time(includingFractionalSeconds: false))) \(message)"
        if toStandardError { CLI.printError(line) } else { print(line) }
        fflush(stdout)
    }
}
