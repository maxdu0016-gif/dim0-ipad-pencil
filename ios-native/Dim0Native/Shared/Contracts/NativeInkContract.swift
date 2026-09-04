import Foundation

struct NativePencilCamera: Codable, Equatable, Sendable {
    let x: Double
    let y: Double
    let zoom: Double
}

struct NativeInkPoint: Codable, Equatable, Sendable {
    let x: Double
    let y: Double
    let pressure: Double
}

struct NativeInkStroke: Codable, Equatable, Sendable {
    enum Tool: String, Codable, Sendable {
        case pen
        case highlighter
    }

    let id: String
    let tool: Tool
    let color: String
    let width: Double
    let opacity: Double
    let points: [NativeInkPoint]
}

/// Complete local PencilKit drawing submitted only when the user requests a sync.
struct NativePencilInkSnapshot: Codable, Equatable, Sendable {
    let kind = "dim0.native-pencil.snapshot"
    let version = 1
    let sessionId: String
    let contextId: String
    let camera: NativePencilCamera
    let strokes: [NativeInkStroke]
}

/// Ordered batch emitted from the crash-safe local Pencil journal.
struct NativePencilInkDelta: Codable, Equatable, Sendable {
    let kind = "dim0.native-pencil.delta"
    let version = 1
    let messageId: String
    let manual: Bool
    let sessionId: String
    let contextId: String
    let camera: NativePencilCamera
    let strokes: [NativeInkStroke]
    let removedStrokeIds: [String]
    let total: Int
}
