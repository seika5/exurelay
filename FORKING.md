# Forking Exurelay

Plugins (Settings → Plugins) cover themes, custom message types and extra screens. To change anything else,
including the core, fork the repository and publish your own build. Your fork talks to the same servers as everyone
else, as long as it keeps the wire format.

## 1. Fork and publish

1. Fork this repository on GitHub (or use it as a template).
2. In your fork: **Settings → Pages → Source: GitHub Actions**.
3. Push to `main`. `.github/workflows/deploy-web.yml` runs the tests, builds `relay-web` and publishes it. The run summary shows your build's commit and hash, and your app shows them in Settings → General.
4. Optional: a custom domain (Settings → Pages). Without one the app is served under `/<your-repo>/`, which the build handles (`BASE_PATH`).

Any static HTTPS host works too: `cd relay-web && npm ci && npm run build`, then publish `relay-web/out/` (set
`BASE_PATH` if it's served under a path).

## 2. Keep it compatible

`relay-web/src/lib/__tests__/vectors.test.ts` opens recorded outputs of every wire format: sealed blobs, push
payloads, call signals and identity files (`vectors/protocol-v2.json`). If it fails, your change would stop you from
messaging everyone on the official app and other forks. Fix the change; don't regenerate the vectors. Regenerating
(`GENERATE_VECTORS=1 npx vitest run vectors`) is only for a deliberate new protocol version that every client adopts.

What you can change freely: anything in the UI (`src/app`, `src/components`), and anything inside the encrypted
message content as long as other clients can still show it (prefer a plugin message type with fallback text).
What breaks compatibility: `src/lib/sealed.ts`, `push.ts`, `callSignal.ts`, `signed.ts` (signed records),
`identityFile.ts`, and the server API.

## 3. Using your fork

Each web address has its own storage, so your fork is a different "device" from the official app, even on the same
computer: create an identity on it and link it from a device you already have (Settings → Devices). It then gets
your messages from the moment it's linked.

## 4. Security notes

- Whoever controls the host serving your build can change it at any time; the published commit and hash in Settings → General let users check.
- Keep the strict CSP from `scripts/postbuild.mjs`. If you add a script or a third-party connection, add it there deliberately.
- Don't weaken `public/plugin-host.html`: it's what keeps plugins away from keys and the network.
