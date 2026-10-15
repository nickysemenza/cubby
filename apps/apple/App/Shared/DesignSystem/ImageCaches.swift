import Nuke

/// Wipes Nuke's memory and on-disk thumbnail caches, mirroring `SpotlightIndexer.wipe()`: a
/// signed-out session or a switch to a different base URL must never let a stale thumbnail (a
/// cover image belonging to another household's product) linger on screen or on disk.
enum ImageCaches {
    static func reset() {
        ImagePipeline.shared.cache.removeAll()
    }
}
