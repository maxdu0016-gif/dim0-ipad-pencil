# Offline LAN pairing

Status: proposed implementation, not shipped. User selected offline board sync
and accepted running the Dim0 desktop app as the local connection service.

## User flow

1. Open a locally available board in Dim0 desktop and choose **Offline pairing**.
2. Desktop starts a local service and displays a short-lived QR invitation.
3. In Dim0 iPad, choose **Scan to pair**, scan, and confirm the desktop and board.
4. Both devices confirm pairing. Initial board content and its local attachments
   are transferred before the UI reports **Ready offline**.
5. Edits persist locally and synchronize while both apps are running and the
   devices can reach each other on the same Wi-Fi or hotspot.
6. Disconnecting preserves both local copies. Reconnecting resumes pending edits.
   Unpairing revokes access without deleting either copy.

No internet, cloud account, or cloud signaling service is required for this flow.
Initial installation and downloading uncached external resources still require
connectivity. AI inference remains an independent online feature.

## Reuse and boundaries

- Reuse `board-sync.ts` and the client rebase rules in ADR-SYNC-001. Do not build
  another merge algorithm or replace a receiving board with an incoming snapshot.
- Desktop is the session's durable sequencer and relay. Sequence numbers and
  batch deduplication survive app restarts. Cloud and LAN must never independently
  sequence the same active session. Keep existing cloud boards unchanged until
  an explicit migration/bridging protocol exists.
- Reuse `StorageEngine`, desktop SQLite, and iPad IndexedDB. Initial transfer
  includes every folder layer and locally stored assets needed by that board.
  Missing assets must be reported rather than treating a partial transfer as done.
- Reuse the native Pencil checkpoint/export/ack path. Do not acknowledge native
  ink merely because a network write succeeded; local durability comes first.
- Camera position and selection remain device-local. Do not transfer API keys,
  login credentials, or unrelated boards.

## Implementation seams

- `webui/src-tauri/src/`: local listener, durable relay, pairing lifetime,
  revocation, explicit network-interface selection and native transport commands.
  The existing `tiny_http` dependency currently serves OAuth loopback only; it
  is not an existing LAN sync server.
- `webui/src/features/board/harness/sync/`: adapt the transport used by the
  coordinator to local native connections while preserving its wire semantics,
  single local-batch intake, acknowledgment and outbox rules.
- Desktop and iPad UI: pairing, connection state, initial-transfer progress,
  actionable network errors, disconnect and unpair.
- `ios-native/Dim0Native/Features/WebApp/`: scanner, native local transport and
  strict trusted-origin bridge. Provide manual invitation entry as an accessible
  fallback. Camera usage text must be added; local-network usage text exists.
- iPad bootstrap: supply and validate a bundled/offline UI so cold launching
  without internet does not depend on `dim0-ipad-pencil.pages.dev` being reachable.
  Preserve current app storage and Pencil recovery identifiers during bootstrap
  changes; a different web origin must not strand existing boards.

## Pairing and transport requirements

Use a random, short-lived, single-use invitation bound to one desktop and board.
Authenticate the desktop's encrypted connection using identity material carried
by the QR invitation, with native certificate/key verification. Never disable
TLS checks globally. Require confirmation before exposing board data; a LAN
address alone does not authorize access. Limit payload size, validate messages,
and revoke sessions on unpairing. Do not expose storage or filesystem APIs on
the network. Handle multiple adapters, changed IP addresses, firewall denial,
and Wi-Fi client isolation explicitly.

## Release acceptance

- Install desktop and iPad builds, remove internet access while retaining the
  LAN, then cold-launch both and complete QR pairing.
- Transfer a board with text, shapes, connectors, Pencil strokes, nested folders
  and locally available attachments; compare persisted contents on both devices.
- Concurrent edits, deletion and undo converge. Connection loss, process restart,
  duplicate delivery and interrupted initial transfer do not lose local edits.
- Expired, reused, altered and revoked invitations fail safely. An unpaired LAN
  client cannot read or alter a board.
- Existing cloud sync and local-only boards continue to work. Old boards and
  native recovery journals remain accessible after updating the iPad build.
- Pass frontend checks, relay tests, native CI and a real Windows/iPad offline
  test before publishing. A browser-only simulation does not establish iPad
  local-network, camera, TLS or cold-launch behavior.

## Rollback baseline

## Implementation checkpoint — 2026-09-05

Development branch: `codex/offline-lan-pairing`. Local rollback branch:
`codex/rollback-before-lan-fe27e357`. This checkpoint is experimental and must
not replace the published frontend or TestFlight build 15.

Implemented: board-scoped SQLite journal, native HTTPS relay, expiring QR
invitations, desktop approval/revocation, iPad Keychain credentials and pinned
TLS transport, retrying outbox, whole-board synchronization with visible-layer
projection, initial document/widget-state import, local image insertion, and
a bundled offline HTML shell using the existing HTTPS storage origin.

Verified locally: 34 frontend synchronization/import tests; four Rust journal
and authorization tests; Tauri library compilation; TypeScript and ESLint;
offline Vite build; browser startup, local board creation and pairing dialog
with all non-navigation network requests blocked. These do not establish native
iPad camera, TLS, local-network permission or migration correctness.

Release blockers still requiring implementation/verification: complete pause and
unpair flows; changed-IP recovery; ongoing document/widget-state synchronization
after the initial import; validation of external attachment availability;
native CI and actual Windows/iPad offline acceptance. Initial transfer currently
uses bounded JSON (32 MB), with whole-request retries, and has no chunked transfer
progress. AI/OCR and embedded mini-app services retain their existing internet
requirements. Existing native Pencil durability is reused, not independently
certified by the browser smoke test.

## Preserved release artifacts

Current shipped frontend source: `fe27e357` (touch shape editing and deletion).
Current native release: 1.2.0 build 15. Existing build 14 and pre-shape-fix
backups remain intact. Implement LAN work on a separate branch and retain these
artifacts; do not overwrite the live frontend with incomplete pairing controls.
