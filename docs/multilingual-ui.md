# Interface language

The frontend supports English (`en`) and Simplified Chinese (`zh-CN`). The default
is the device language: Chinese device locales use Simplified Chinese; other
locales use English. A device-local override is available in **Agent settings →
General → 语言 / Language**, the account settings screen, and the sign-in screen.
Changing the language updates subscribed components without remounting them or
discarding input drafts. The selection persists as `dim0-language` in localStorage
and synchronizes between tabs. Storage denial leaves an in-memory preference.

The shared dictionary is `webui/src/lib/translations/zh-CN.ts`. Components use
`useT()` from `webui/src/lib/i18n.ts`; non-React UI message producers may use `t()`.
Translate interface text at render time, including labels in static option arrays.
Do not translate control IDs, model IDs, credentials, user-authored notes, chat
responses, or mini-app output. Unknown messages retain their English source.

Current coverage includes AI service settings, language selection, main chat
inputs, native dictation draft controls, tool confirmation, primary canvas tools,
viewport controls, note search, board overview, sidebar navigation, account
settings, and sign-in. Secondary feature screens and third-party editor controls
can still contain English. Provider and Apple system error messages retain their
original language; Apple permission dialogs follow the operating system.

The iPad speech bridge receives `zh-CN` or `en-US` based on the selected interface
language for each new dictation request. This frontend change does not add speech
support to older native builds; in-app dictation still needs Build 18 or later.

## Verification

- `npm run check-all` (TypeScript and ESLint).
- `npx vitest run src/components/language-setting.test.tsx
  src/features/agent/components/chat/speech-input.test.tsx
  src/features/board/components/flow/floating-assistant/floating-island.test.tsx
  src/features/board/harness/chrome/toolbar.test.tsx
  src/features/board/screens/boards-home.test.tsx`.
- Browser: switch languages in settings, reload, inspect the persisted selection;
  verify the settings dialog at an 834 × 1194 viewport.
- Build both the mini-app runtime and main frontend with their Vite configs.

The language tests check immediate updates, key-draft preservation, reload
restoration, interpolation, unsupported device language fallback, and storage
failure. This change must be deployed to the webpage before existing iPad users
can see it; no native binary rebuild is required for these interface changes.
