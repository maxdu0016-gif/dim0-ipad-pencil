import CoreGraphics
import Foundation
import XCTest
@testable import Dim0Native

final class Dim0WebAppConfigurationTests: XCTestCase {
    /// Production navigation requires TLS, while development HTTP stays local.
    func testAllowedWebURLPolicy() throws {
        XCTAssertTrue(Dim0WebAppConfiguration.isAllowedWebURL(
            try XCTUnwrap(URL(string: "https://app.dim0.net/local/board"))
        ))
        XCTAssertTrue(Dim0WebAppConfiguration.isAllowedWebURL(
            try XCTUnwrap(URL(string: "http://192.168.1.20:5175"))
        ))
        XCTAssertTrue(Dim0WebAppConfiguration.isAllowedWebURL(
            try XCTUnwrap(URL(string: "http://dim0.local:5175"))
        ))
        XCTAssertFalse(Dim0WebAppConfiguration.isAllowedWebURL(
            try XCTUnwrap(URL(string: "http://example.com"))
        ))
        XCTAssertFalse(Dim0WebAppConfiguration.isAllowedWebURL(
            try XCTUnwrap(URL(string: "file:///tmp/index.html"))
        ))
    }

    /// Manual native snapshots retain their board context across bridge round trips.
    func testSnapshotRoundTrip() throws {
        let message = NativePencilInkSnapshot(
            sessionId: "ad7dbd1d-7235-49c9-854f-c00613504eae",
            contextId: "board:folder",
            camera: NativePencilCamera(x: 0, y: 0, zoom: 1),
            strokes: [NativeInkStroke(
                id: String(repeating: "a", count: 64),
                tool: .pen,
                color: "#123456",
                width: 5,
                opacity: 1,
                points: [NativeInkPoint(x: 1, y: 2, pressure: 0.5)]
            )]
        )

        let restored = try JSONDecoder().decode(
            NativePencilInkSnapshot.self,
            from: JSONEncoder().encode(message)
        )

        XCTAssertEqual(restored, message)
    }

    /// Incremental native messages preserve additions, erasures, and document size.
    func testPencilDeltaRoundTrip() throws {
        let message = NativePencilInkDelta(
            messageId: "3542be13-0a1b-4add-921b-b2a867129b73",
            manual: true,
            sessionId: "ad7dbd1d-7235-49c9-854f-c00613504eae",
            contextId: "board:folder",
            camera: NativePencilCamera(x: 10, y: 20, zoom: 2),
            strokes: [],
            removedStrokeIds: [String(repeating: "a", count: 64)],
            total: 3
        )

        let restored = try JSONDecoder().decode(
            NativePencilInkDelta.self,
            from: JSONEncoder().encode(message)
        )

        XCTAssertEqual(restored, message)
    }

    func testPencilDocumentStoreRejectsOlderSaveRevision() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = NativePencilDocumentStore(baseDirectory: directory)
        let newest = NativePencilDocument(
            drawing: Data([9]),
            camera: NativePencilCamera(x: 0, y: 0, zoom: 1),
            coordinateSpace: "pending-world-v1",
            strokeColors: [:]
        )
        let stale = NativePencilDocument(
            drawing: Data([1]),
            camera: NativePencilCamera(x: 0, y: 0, zoom: 1),
            coordinateSpace: "pending-world-v1",
            strokeColors: [:]
        )

        try await store.save(newest, contextId: "board", revision: 2)
        try await store.save(stale, contextId: "board", revision: 1)

        let restored = try await store.load(contextId: "board")
        XCTAssertEqual(restored, newest)
    }

    func testPencilDocumentStoreSeparatesBoardContexts() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = NativePencilDocumentStore(baseDirectory: directory)
        let first = NativePencilDocument(
            drawing: Data([1, 2, 3]),
            camera: NativePencilCamera(x: 10, y: 20, zoom: 2),
            coordinateSpace: "world-v1",
            strokeColors: [String(repeating: "a", count: 64): "#123456"]
        )
        let second = NativePencilDocument(
            drawing: Data([4, 5]),
            camera: NativePencilCamera(x: -2, y: 3, zoom: 0.5),
            coordinateSpace: nil,
            strokeColors: [:]
        )

        try await store.save(first, contextId: "board-a:")
        try await store.save(second, contextId: "board-b:folder")

        let restoredFirst = try await store.load(contextId: "board-a:")
        let restoredSecond = try await store.load(contextId: "board-b:folder")
        XCTAssertEqual(restoredFirst, first)
        XCTAssertEqual(restoredSecond, second)
    }

    /// World coordinates survive repeated camera projection without cumulative drift.
    @MainActor
    func testPencilCameraProjectionRoundTrip() {
        let camera = NativePencilCamera(x: 125, y: -40, zoom: 2.5)
        let worldPoint = CGPoint(x: 180, y: 24)
        let screenPoint = worldPoint.applying(NativePencilWebContainer.worldToScreenTransform(camera))
        let restored = screenPoint.applying(NativePencilWebContainer.screenToWorldTransform(camera))

        XCTAssertEqual(restored.x, worldPoint.x, accuracy: 0.000_001)
        XCTAssertEqual(restored.y, worldPoint.y, accuracy: 0.000_001)
    }

    /// ACK reconciliation must wait through both active input and PencilKit's final update window.
    @MainActor
    func testPencilCanvasReplacementWaitsForFinalDrawingChange() {
        XCTAssertFalse(NativePencilWebContainer.canReplaceCanvasDrawing(
            isUsingTool: true,
            isAwaitingFinalDrawingChange: false
        ))
        XCTAssertFalse(NativePencilWebContainer.canReplaceCanvasDrawing(
            isUsingTool: false,
            isAwaitingFinalDrawingChange: true
        ))
        XCTAssertTrue(NativePencilWebContainer.canReplaceCanvasDrawing(
            isUsingTool: false,
            isAwaitingFinalDrawingChange: false
        ))
    }
}
