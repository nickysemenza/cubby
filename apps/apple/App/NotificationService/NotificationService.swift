import Foundation
import UserNotifications

/// Optional media never delays the system's text fallback beyond the extension deadline.
final class NotificationService: UNNotificationServiceExtension, @unchecked Sendable {
    private let lock = NSLock()
    private var handler: ((UNNotificationContent) -> Void)?
    private var content: UNMutableNotificationContent?
    private var work: Task<Void, Never>?

    override func didReceive(
        _ request: UNNotificationRequest,
        withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        guard let mutable = request.content.mutableCopy() as? UNMutableNotificationContent else {
            contentHandler(request.content)
            return
        }
        lock.lock()
        handler = contentHandler
        content = mutable
        lock.unlock()
        guard let value = request.content.userInfo["imageUrl"] as? String,
            let url = URL(string: value), url.scheme == "https", url.user == nil, url.password == nil
        else { finish(); return }
        work = Task { [weak self] in
            do {
                var request = URLRequest(url: url)
                request.timeoutInterval = 10
                let (bytes, response) = try await URLSession.shared.bytes(for: request)
                guard let response = response as? HTTPURLResponse, response.statusCode == 200,
                    response.mimeType?.hasPrefix("image/") == true,
                    response.expectedContentLength <= 5_000_000
                else { self?.finish(); return }
                var data = Data()
                for try await byte in bytes {
                    if Task.isCancelled || data.count >= 5_000_000 { self?.finish(); return }
                    data.append(byte)
                }
                let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
                    UUID().uuidString)
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                let file = directory.appendingPathComponent("cover.jpg")
                try data.write(to: file)
                let attachment = try UNNotificationAttachment(identifier: "cover", url: file)
                self?.finish(attachment: attachment)
            } catch { self?.finish() }
        }
    }

    override func serviceExtensionTimeWillExpire() {
        work?.cancel()
        finish()
    }

    private func finish(attachment: UNNotificationAttachment? = nil) {
        lock.lock()
        let callback = handler
        let result = content
        handler = nil
        content = nil
        if let attachment { result?.attachments = [attachment] }
        lock.unlock()
        if let callback, let result { callback(result) }
    }
}
