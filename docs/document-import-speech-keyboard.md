# Document import, dictation, and iPad keyboard layout

Web UI 0.3.94 adds PDF/DOCX/PPTX drag-and-drop on local boards, using the same
ingestion and document search index as the attachment and toolbar import actions.
Dropped document cards use the drop coordinates. Same-name replacement requires
confirmation; empty parsing results leave existing content intact.

DOCX and PPTX text is extracted on the device (5 MB input limit, 20 MB extracted XML
limit), without a parsing API key. Paragraphs, text in table cells, and slide text
are readable by AI. Presentation order follows the relationship list. Embedded
images, charts, layout, and speaker notes are not extracted. DOC and PPT must be
saved as DOCX/PPTX or PDF. PDF OCR still requires managed parsing or a Mistral key.
Legacy server boards retain their existing PDF-only server import.

Native iPad dictation remains the preferred recognizer. Browsers exposing
SpeechRecognition or webkitSpeechRecognition now use the same editable draft
dialog. Recognition is never automatically sent to AI. Browser support, network,
and microphone permission affect availability. The dialog does not automatically
focus a text field and open the keyboard while recording.

The native web root clips overflow, preventing focus-induced scrolling of the
whole app. Its height tracks visualViewport changes; chat and editor panes retain
their own scrolling. The existing native outer-scroll guard remains in place.
This web update works with iPad 1.2.1 build 19 when it loads the online app.
Real iPad keyboard animations and microphone permissions require device validation.
