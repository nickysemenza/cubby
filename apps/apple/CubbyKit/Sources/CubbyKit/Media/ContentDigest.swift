import CryptoKit
import Foundation

extension Data {
    /// Lowercase hex SHA-256: the spelling every image, artifact, and evidence checksum carries.
    var sha256Hex: String {
        SHA256.hash(data: self).map { String(format: "%02x", $0) }.joined()
    }
}
