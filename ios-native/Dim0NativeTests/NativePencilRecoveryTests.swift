import PencilKit
import UIKit
import WebKit
import XCTest
@testable import Dim0Native

@MainActor
final class NativePencilRecoveryTests: XCTestCase {
    /// The native escape path releases intercepted touches without waiting for JavaScript or losing ink.
    func testExitHandwritingReleasesTouchesAndKeepsRecoveryInk() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = NativePencilDocumentStore(baseDirectory: directory)
        let (container, canvas) = try await makeContainer(store: store)
        canvas.drawing = makeDrawing()
        let exit = try XCTUnwrap(container.subviews.compactMap { $0 as? UIButton }.first)
        XCTAssertFalse(exit.isHidden)
        container.stopHandwriting()
        XCTAssertFalse(canvas.isUserInteractionEnabled)
        XCTAssertTrue(exit.isHidden)
        XCTAssertEqual(canvas.drawing.strokes.count, 1)
        await container.saveTask?.value
        let document = try await store.load(contextId: "recovery-board:")
        XCTAssertEqual(try PKDrawing(data: XCTUnwrap(document).drawing).strokes.count, 1)
    }

    /// WebKit's keyboard-induced outer scroll cannot move the fixed app frame.
    func testKeyboardCannotPanOuterWebView() {
        let coordinator = Dim0WebView.Coordinator(model: Dim0WebAppModel())
        let scrollView = UIScrollView()
        scrollView.contentOffset = CGPoint(x: 40, y: 160)
        coordinator.scrollViewDidScroll(scrollView)
        XCTAssertEqual(scrollView.contentOffset, .zero)
        coordinator.scrollViewDidScroll(scrollView)
        XCTAssertEqual(scrollView.contentOffset, .zero)
    }

    /// The immutable export can run away from the UI thread and retain the original stored color.
    func testBackgroundExportPreservesStrokeIdentityAndColor() async throws {
        let drawing = makeDrawing()
        let id = PencilStrokeExporter.stableId(for: drawing.strokes[0])
        let (onMainThread, strokes) = await Task.detached {
            (Thread.isMainThread, PencilStrokeExporter.exportStrokes(drawing, colors: [id: "#ABCDEF"]))
        }.value
        XCTAssertFalse(onMainThread)
        XCTAssertEqual(strokes.count, 1)
        XCTAssertEqual(strokes.first?.id, id)
        XCTAssertEqual(strokes.first?.color, "#ABCDEF")
        XCTAssertFalse(try XCTUnwrap(strokes.first).points.isEmpty)
    }

    /// Shared per-board journals require a single native window until writer ownership is implemented.
    func testAppDisablesMultipleJournalWriters() throws {
        let manifest = try XCTUnwrap(Bundle.main.object(forInfoDictionaryKey: "UIApplicationSceneManifest") as? [String: Any])
        XCTAssertEqual(manifest["UIApplicationSupportsMultipleScenes"] as? Bool, false)
    }

    /// A new Pencil contact cannot cancel the preceding tool-up checkpoint.
    func testToolUpPersistsBeforeFinalCallbackAndNextContact() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = NativePencilDocumentStore(baseDirectory: directory)
        let (container, canvas) = try await makeContainer(store: store)
        let drawing = makeDrawing()

        container.canvasViewDidBeginUsingTool(canvas)
        canvas.drawing = drawing
        container.canvasViewDrawingDidChange(canvas)
        container.canvasViewDidEndUsingTool(canvas)
        let checkpoint = try XCTUnwrap(container.saveTask)
        container.canvasViewDidBeginUsingTool(canvas)
        await checkpoint.value

        let stored = try await store.load(contextId: "recovery-board:")
        let document = try XCTUnwrap(stored)
        let recovered = try PKDrawing(data: document.drawing)
        XCTAssertEqual(recovered.strokes.count, 1)
        let stroke = try XCTUnwrap(recovered.strokes.first)
        let point = stroke.path[0].location.applying(stroke.transform)
        XCTAssertEqual(point.x, 110, accuracy: 0.001)
        XCTAssertEqual(point.y, 70, accuracy: 0.001)
        XCTAssertEqual(document.coordinateSpace, "pending-world-v1")
        XCTAssertEqual(document.strokeColors?[PencilStrokeExporter.stableId(for: stroke)], "#123456")
        XCTAssertEqual(canvas.drawing, drawing, "Checkpointing must never replace the live canvas")
    }

    /// Lifecycle saves read visible ink even when the final delegate callback has not arrived.
    func testResignActiveAndBackgroundSaveLatestVisibleDrawing() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = NativePencilDocumentStore(baseDirectory: directory)
        let (container, canvas) = try await makeContainer(store: store)

        container.canvasViewDidBeginUsingTool(canvas)
        canvas.drawing = makeDrawing()
        NotificationCenter.default.post(name: UIApplication.willResignActiveNotification, object: nil)
        let firstSave = try XCTUnwrap(container.saveTask)
        await firstSave.value
        let first = try await store.load(contextId: "recovery-board:")
        XCTAssertEqual(try PKDrawing(data: XCTUnwrap(first).drawing).strokes.count, 1)

        canvas.drawing = PKDrawing(strokes: canvas.drawing.strokes + makeDrawing().strokes)
        NotificationCenter.default.post(name: UIApplication.didEnterBackgroundNotification, object: nil)
        await container.saveTask?.value
        let latest = try await store.load(contextId: "recovery-board:")
        XCTAssertEqual(try PKDrawing(data: XCTUnwrap(latest).drawing).strokes.count, 2)
        XCTAssertEqual(canvas.drawing.strokes.count, 2)
    }

    /// The post-tool content callback immediately supersedes an earlier recovery snapshot.
    func testFinalCallbackUpdatesCheckpointWithoutIdleDebounce() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = NativePencilDocumentStore(baseDirectory: directory)
        let (container, canvas) = try await makeContainer(store: store)
        container.canvasViewDidBeginUsingTool(canvas)
        canvas.drawing = makeDrawing()
        container.canvasViewDidEndUsingTool(canvas)
        await container.saveTask?.value

        canvas.drawing = PKDrawing(strokes: canvas.drawing.strokes + makeDrawing().strokes)
        container.canvasViewDrawingDidChange(canvas)
        let checkpoint = try XCTUnwrap(container.saveTask)
        // Cancel every idle fallback to ensure the final callback itself saved the new drawing.
        container.canvasViewDidBeginUsingTool(canvas)
        await checkpoint.value

        let stored = try await store.load(contextId: "recovery-board:")
        XCTAssertEqual(try PKDrawing(data: XCTUnwrap(stored).drawing).strokes.count, 2)
    }

    /// Uses the production load path with isolated storage and explicit delegate event ordering.
    private func makeContainer(store: NativePencilDocumentStore) async throws -> (NativePencilWebContainer, PKCanvasView) {
        let webView = PencilAwareWebView(frame: .zero, configuration: WKWebViewConfiguration())
        let container = NativePencilWebContainer(webView: webView, documentStore: store)
        let canvas = try XCTUnwrap(container.subviews.compactMap { $0 as? PKCanvasView }.first)
        canvas.delegate = nil
        container.configurePencil(
            enabled: true,
            frame: CGRect(x: 0, y: 0, width: 400, height: 400),
            passthroughRects: [],
            color: .black,
            contextId: "recovery-board:",
            storedColor: "#123456",
            width: 4,
            erasing: false,
            camera: NativePencilCamera(x: 100, y: 50, zoom: 2)
        )
        for _ in 0..<100 {
            if canvas.isUserInteractionEnabled { return (container, canvas) }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTFail("Native journal did not finish loading")
        throw NSError(domain: "NativePencilRecoveryTests", code: 1)
    }

    /// Builds real PencilKit ink so the test exercises serialization and world-coordinate recovery.
    private func makeDrawing() -> PKDrawing {
        let points = [CGPoint(x: 20, y: 40), CGPoint(x: 40, y: 60)].enumerated().map { index, point in
            PKStrokePoint(
                location: point,
                timeOffset: Double(index) * 0.1,
                size: CGSize(width: 4, height: 4),
                opacity: 1,
                force: 0.5,
                azimuth: 0,
                altitude: .pi / 2
            )
        }
        let stroke = PKStroke(ink: PKInk(.pen, color: .black), path: PKStrokePath(controlPoints: points, creationDate: Date()))
        return PKDrawing(strokes: [stroke])
    }
}
