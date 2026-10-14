import Foundation
import Synchronization

/// OS-owned file transfers continue while the iOS process is suspended. Task descriptions use
/// the journal-owned file path, so reopening attaches to the same transfer instead of duplicating it.
/// Delegate state is mutex protected; URLSession calls delegates on its own queue.
public final class PhotoImportBackgroundUpload: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    public static let shared = PhotoImportBackgroundUpload()
    public static let identifier = "com.cubby.photo-import.uploads"
    private struct State {
        var waiters: [Int: CheckedContinuation<Void, any Error>] = [:]
        var completed: [String: Result<Void, any Error>] = [:]
        var bodies: [Int: Data] = [:]
        var eventsFinished: (@Sendable () -> Void)?
        var finishedBeforeHandler = false
    }
    private let state = Mutex(State())
    private var session: URLSession!

    private override init() {
        super.init()
        #if os(iOS)
            let configuration = URLSessionConfiguration.background(withIdentifier: Self.identifier)
            configuration.sessionSendsLaunchEvents = true
            configuration.isDiscretionary = false
        #else
            let configuration = URLSessionConfiguration.default
        #endif
        configuration.allowsCellularAccess = false
        configuration.allowsExpensiveNetworkAccess = false
        configuration.allowsConstrainedNetworkAccess = false
        session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    }

    public func handleEvents(completion: @escaping @Sendable () -> Void) {
        let finished = state.withLock { state in
            if state.finishedBeforeHandler {
                state.finishedBeforeHandler = false
                return true
            }
            state.eventsFinished = completion
            return false
        }
        if finished { completion() }
    }

    public func put(file: URL, to url: URL, contentType: String) async throws {
        try Task.checkCancellation()
        let key = file.path
        if let completed = state.withLock({ $0.completed.removeValue(forKey: key) }) {
            return try completed.get()
        }
        let existing = await session.allTasks.first { $0.taskDescription == key }
        if let completed = state.withLock({ $0.completed.removeValue(forKey: key) }) {
            return try completed.get()
        }
        if existing == nil { try await PhotoImportConditions.shared.wait() }
        try Task.checkCancellation()
        var request = URLRequest(url: url)
        request.httpMethod = "PUT"
        request.setValue(contentType, forHTTPHeaderField: "Content-Type")
        let task = existing ?? session.uploadTask(with: request, fromFile: file)
        task.taskDescription = key
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                let completed = state.withLock { state -> Result<Void, any Error>? in
                    if let completed = state.completed.removeValue(forKey: key) { return completed }
                    state.waiters[task.taskIdentifier] = continuation
                    return nil
                }
                if let completed {
                    continuation.resume(with: completed)
                } else if Task.isCancelled {
                    task.cancel()
                } else {
                    task.resume()
                }
            }
        } onCancel: {
            let waiter = self.state.withLock { $0.waiters.removeValue(forKey: task.taskIdentifier) }
            waiter?.resume(throwing: CancellationError())
        }
    }

    public func cancel(files: [URL]) async {
        let paths = Set(files.map(\.path))
        for task in await session.allTasks where task.taskDescription.map(paths.contains) == true {
            task.cancel()
        }
    }

    public func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        state.withLock { $0.bodies[dataTask.taskIdentifier, default: Data()].append(data) }
    }

    public func urlSession(
        _ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?
    ) {
        let body = state.withLock { $0.bodies.removeValue(forKey: task.taskIdentifier) ?? Data() }
        let status = (task.response as? HTTPURLResponse)?.statusCode ?? 0
        let result: Result<Void, any Error>
        if let error {
            result = .failure(error)
        } else if (200..<300).contains(status) {
            result = .success(())
        } else {
            result = .failure(CubbyAPIError.decode(status: status, operationID: "presigned.put", body: body))
        }
        let waiter = state.withLock { state -> CheckedContinuation<Void, any Error>? in
            if let waiter = state.waiters.removeValue(forKey: task.taskIdentifier) { return waiter }
            if let key = task.taskDescription { state.completed[key] = result }
            return nil
        }
        waiter?.resume(with: result)
    }

    public func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        let completion = state.withLock { state in
            defer { state.eventsFinished = nil }
            if state.eventsFinished == nil { state.finishedBeforeHandler = true }
            return state.eventsFinished
        }
        completion?()
    }
}
