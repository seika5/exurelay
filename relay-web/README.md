# relay-web

The Next.js web app for Relay. **Run this locally on your machine.** Your identity file stays on your device and is never sent to the server.

See the [root README](../README.md) for full setup instructions (server, web, and mobile).

---

## Requirements

- Node.js v18+ (v20+ recommended)
- npm

---

## Setup

### 1. Configure env

```bash
cp .env.local.example .env.local
```

Edit `.env.local`:

```env
NEXT_PUBLIC_API_URL=https://relay.example.com
NEXT_PUBLIC_ADMIN_SIGNING_KEYS=ADMIN_KEY_FROM_THE_HOST
```

### 2. Create your identity

On first run the app creates your keys and saves them to `public/identity/identity.bin`. Then show the admin your enrollment code (see the main README, 2.2).

### 3. Install and run

```bash
npm i
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

---

## Customizing the UI

You can edit the look and layout of the app freely. Only change the files listed below. Touching core crypto or identity code can break compatibility or corrupt your identity.

### Safe to edit

- **`src/app/page.tsx`**: Main chat view (sidebar, messages, modals). Change layout, labels, and display logic.
- **`src/app/layout.tsx`**: Root layout and metadata.
- **`src/app/globals.css`**: Global styles and CSS variables (`--bg`, `--text`, `--accent`, `--surface`, `--border`, `--muted`). Adjust colors and theme here.
- **New or edited components under `src/app/` or `src/components/`**: As long as they consume `useIdentity()` and `useMessages(identity)` for data and don't change how identity or blobs work.

### Do not change

- **`src/lib/identityBinary.ts`**, **`src/lib/crypto.ts`**, **`src/lib/e2ee.ts`**: Identity format and encryption.
- **`src/lib/blobPayload.ts`**, **`src/lib/blobChunk.ts`**, **`src/lib/api.ts`**: Blob protocol and server API.
- **`src/context/IdentityContext.tsx`**, **`src/lib/useMessages.ts`**: Identity state and message loading.

Changing these can break server compatibility or corrupt your identity binary.

---

## Building for iOS (mobile)

The `build:mobile` script produces a static export consumed by the Capacitor iOS wrapper in `relay-mobile/`. See the [root README section 3](../README.md#3-mobile-app-setup-ios-each-user) for the full mobile build and sideload walkthrough.

```bash
npm run build:mobile   # outputs to relay-web/out/
```
