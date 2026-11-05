# relay-web

The Exurelay app: a Next.js app built as a static web app (PWA). People use the published build (installed on phones,
in Chrome/Edge on computers), a fork's build, or their own local copy. Keys are made on the device and never sent
anywhere: in desktop Chrome/Edge as a passphrase-encrypted file in a folder you pick, elsewhere as non-exportable keys
in the app's storage.

See the [root README](../README.md) for using and hosting it, [FORKING.md](../FORKING.md) for publishing your own
build, and [DESIGN.md](../DESIGN.md) for how it works.

---

## Requirements

Node.js 20+ and npm.

## Commands

```bash
npm ci
npm run dev       # development server, http://127.0.0.1:3000
npm test          # unit tests, including the protocol test vectors
npm run build     # static export to out/, then scripts/postbuild.mjs adds the CSP and build.json
npm start         # serve out/ locally, http://127.0.0.1:3000
```

Optional: to preset one server for a build, copy `.env.local.example` to `.env.local` and set both values. Otherwise
the app asks for a join code.

## Where things are

| Path | What |
| --- | --- |
| `src/app/page.tsx`, `src/components/` | The UI |
| `src/context/` | Identity and devices, calls, plugins |
| `src/lib/sealed.ts` | Protocol v2: sealed, recipient-blind blobs |
| `src/lib/useMessages.ts`, `messageCache.ts` | Sync, sending, the encrypted local cache |
| `src/lib/signed.ts`, `server.ts` | Signed member list, devices, join and enrollment codes |
| `src/lib/keystore.ts`, `identityFile.ts` | Where keys live (IndexedDB, or the encrypted identity file) |
| `src/lib/session.ts`, `tokens.ts` | Login and anonymous tokens |
| `src/lib/callSignal.ts`, `push.ts` | Sealed call signaling, encrypted push payloads |
| `src/lib/plugins.ts`, `public/plugin-host.html` | The plugin sandbox and API |
| `public/sw.js`, `public/manifest.webmanifest` | Service worker (offline, push) and install manifest |
| `scripts/` | Post-build CSP and build hash, local server, icons |

## Changing it

The UI (`src/app`, `src/components`, `globals.css`) is yours to change. For colors, a plugin is easier. Don't change `sealed.ts`, `push.ts`, `callSignal.ts`, `signed.ts`, `identityFile.ts` or
the server API without bumping the protocol: the test vectors fail if a change would stop you messaging everyone
else (see FORKING.md).
