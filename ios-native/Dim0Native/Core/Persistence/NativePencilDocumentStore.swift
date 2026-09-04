import CryptoKit
import Foundation

struct NativePencilDocument: Codable, Equatable, Sendable {
    let drawing: Data
    let camera: NativePencilCamera
    let coordinateSpace: String?
    let strokeColors: [String: String]?
}

actor NativePencilDocumentStore {
    enum StoreError: Error {
        case applicationSupportUnavailable
    }

    private let fileManager: FileManager
    private let baseDirectory: URL?
    private var latestSaveRevision: [String: UInt64] = [:]

    init(fileManager: FileManager = .default, baseDirectory: URL? = nil) {
        self.fileManager = fileManager
        self.baseDirectory = baseDirectory
    }

    func load(contextId: String) throws -> NativePencilDocument? {
        let fileURL = try documentURL(contextId: contextId)
        guard fileManager.fileExists(atPath: fileURL.path) else { return nil }
        return try JSONDecoder().decode(NativePencilDocument.self, from: Data(contentsOf: fileURL))
    }

    func save(_ document: NativePencilDocument, contextId: String, revision: UInt64 = 0) throws {
        guard revision >= (latestSaveRevision[contextId] ?? 0) else { return }
        let fileURL = try documentURL(contextId: contextId)
        try fileManager.createDirectory(
            at: fileURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try JSONEncoder().encode(document).write(to: fileURL, options: .atomic)
        latestSaveRevision[contextId] = revision
    }

    private func documentURL(contextId: String) throws -> URL {
        let root: URL
        if let baseDirectory {
            root = baseDirectory
        } else {
            guard let applicationSupport = fileManager.urls(
                for: .applicationSupportDirectory,
                in: .userDomainMask
            ).first else {
                throw StoreError.applicationSupportUnavailable
            }
            root = applicationSupport.appendingPathComponent("Dim0/Pencil", isDirectory: true)
        }

        let digest = SHA256.hash(data: Data(contextId.utf8))
            .map { String(format: "%02x", $0) }
            .joined()
        return root.appendingPathComponent("\(digest).drawing", isDirectory: false)
    }
}
