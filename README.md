# Relay

A **hyper-private, E2EE messaging and voice/video** system for a small, closed circle. The server is zero-knowledge (blind relay + temporary encrypted blobs only). No public signup; identities are generated once and **distributed in person** to prevent MITM.

```
relay/
├── relay-web/      Next.js web app. Each user runs this locally on their machine.
├── relay-mobile/   Capacitor iOS wrapper. Each user builds and sideloads their own IPA.
└── relay-server/   Node.js API + worker. Deployed once on a server/VPS.
```

**Each user runs their own copy of the app** (web and/or mobile) and points it at the shared server. Running locally is intentional: it lets each person customize the UI, make edits, and rebuild without touching the server or other users' setups.

See **[DESIGN.md](DESIGN.md)** for the threat model, crypto details, design decisions, and known security gaps.

---

## Features

- **Fixed 20 accounts**: A one-time script generates 20 identity binaries. The server is seeded with those key hashes. Only those keys can use the server.
- **E2EE messaging**: Text and files sent as uniform encrypted blobs (fixed 64 KB size, chunked when larger). The server only sees opaque blobs; no content, length, or file type is visible.
- **Voice/video**: Room-based WebRTC with Socket.io signaling. Mute, deafen, camera, screen share.
- **72-hour blob expiry with timestamp obfuscation**: Blobs expire in a random window around 72 hours. Exact send time is not stored. A background worker deletes expired blobs.
- **Identity**: Binary file only. In-person distribution is strongly recommended.
- **Customizable**: The UI runs locally. Edit it, rebuild, and your changes are live. The server is unaffected.
- **User-facing note:** Message *content* is intended to stay opaque to the relay. *Metadata* (who contacts whom, when, call participation, IPs from ICE) is still visible to the relay. Best mitigation: keep identity distribution off the public web, use a relay you trust, and verify contact keys out-of-band.

---

## Requirements


| Component        | Requirements                                                                          |
| ---------------- | ------------------------------------------------------------------------------------- |
| **relay-web**    | Node.js v18+ (v20+ recommended), npm                                                  |
| **relay-mobile** | macOS, Xcode 15+, Node.js v18+, npm, free Apple ID                                    |
| **relay-server** | Node.js v18+, npm, PostgreSQL. Node.js v19+ for identity generation (Web Crypto API). |


---

## 1. Server setup (one-time, done by whoever hosts)

This is done once. The person running the server generates the 20 identity files and deploys the backend.

### 1.1 Generate identities and the allowed-keys list

```bash
cd relay-server
npm i
node scripts/generate-20-identities.mjs
```

This creates:

- `identities/identity-01.bin` through `identity-20.bin` (give one to each person, ideally in person)
- `allowed-keys-seed.json` (used to seed the database; keep it alongside the server)

### 1.2 Deploy the server

On the machine that will host the relay (e.g. a DigitalOcean droplet, VPS):

1. Copy `relay-server/` to the host (rsync, scp, git, etc.).
2. Install Node.js (v18+) and PostgreSQL. Create an empty database and a DB user.
3. Configure env:
  ```bash
   cp .env.example .env
   # Edit .env: set DATABASE_URL, PORT (e.g. 4000), WEB_ORIGIN (e.g. http://localhost:3000)
  ```
4. Install deps, push schema, and seed keys:
  ```bash
   npm i
   npx prisma db push
   npm run seed
  ```
5. Start the relay:
  ```bash
   npm run start    # API + Socket.io (use PM2 for production: pm2 start src/index.js --name relay-api)
   npm run worker   # Deletes expired blobs (pm2 start src/worker.js --name relay-worker)
  ```
6. Open the firewall: allow the API port (e.g. 4000) and TURN port(s) if using coturn.

### 1.3 TURN server (needed for cross-network calls)

WebRTC media is peer-to-peer. STUN (bundled) works for some same-network setups, but calls across different networks or strict NATs require a TURN relay. Run coturn on the same host:

```bash
sudo apt install -y coturn
```

Edit `/etc/turnserver.conf` (or `/etc/coturn/turnserver.conf`):

```conf
listening-port=3478
lt-cred-mech
user=relay_turn:YOUR_STRONG_TURN_PASSWORD
realm=relay.local
fingerprint
no-multicast-peers
```

Open firewall ports and start:

```bash
sudo ufw allow 3478/udp && sudo ufw allow 3478/tcp && sudo ufw allow 49152:65535/udp
sudo systemctl enable coturn && sudo systemctl start coturn
```

Each user sets these in their `relay-web/.env.local` (and rebuilds the mobile app if using it):

```env
NEXT_PUBLIC_TURN_URL=turn:YOUR_SERVER_IP:3478
NEXT_PUBLIC_TURN_USERNAME=relay_turn
NEXT_PUBLIC_TURN_CREDENTIAL=YOUR_STRONG_TURN_PASSWORD
```

---

## 2. Web app setup (each user)

Each person sets up their own local copy of `relay-web`. Your identity file stays on your machine.

### 2.1 Configure env

```bash
cd relay-web
cp .env.local.example .env.local
```

Edit `.env.local`:

```env
NEXT_PUBLIC_API_URL=http://YOUR_SERVER_IP:4000
NEXT_PUBLIC_TURN_URL=turn:YOUR_SERVER_IP:3478
NEXT_PUBLIC_TURN_USERNAME=relay_turn
NEXT_PUBLIC_TURN_CREDENTIAL=YOUR_STRONG_TURN_PASSWORD
```

### 2.2 Add your identity file

Copy your `identity-NN.bin` (received from whoever runs the server) to:

```
relay-web/public/identity/identity.bin
```

### 2.3 Install and run

```bash
npm i
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### 2.4 Customizing the web app

You can edit the UI freely. See `relay-web/README.md` for which files are safe to change.

---

## 3. Mobile app setup, iOS (each user)

Each person builds and sideloads their own IPA. You need macOS and Xcode 15+.

### 3.1 Prerequisites

- macOS (Ventura 13+ recommended)
- [Xcode 15+](https://apps.apple.com/app/xcode/id497799835) from the Mac App Store
- Free Apple ID (no paid developer account required)
- Node.js v18+

Accept the Xcode license if you haven't:

```bash
sudo xcodebuild -license accept
```

### 3.2 Configure the server URL

Set `NEXT_PUBLIC_API_URL` (and TURN vars if applicable) in `relay-web/.env.local` to point at the deployed server. This must not be `localhost`; it is baked into the app at build time.

```env
NEXT_PUBLIC_API_URL=http://YOUR_SERVER_IP:4000
```

### 3.3 Install dependencies

```bash
# Web app deps (includes Capacitor plugins)
cd relay-web && npm install

# Mobile wrapper deps
cd ../relay-mobile && npm install
```

### 3.4 Build the static web export and sync to Xcode

```bash
cd relay-mobile
npm run build
```

This runs `relay-web`'s `build:mobile` (static Next.js export into `relay-web/out/`) then `npx cap sync ios` to copy those assets into the Xcode project.

### 3.5 Open Xcode

```bash
npm run open
```

### 3.6 Sign the app in Xcode

1. Click **App** (the top-level project item) in the left navigator.
2. Select the **App** target, then open the **Signing & Capabilities** tab.
3. Check **Automatically manage signing**.
4. Set **Team** to your personal Apple ID. If it is not listed, go to **Xcode > Settings > Accounts > Add Account**.

### 3.7 Build the IPA (free Apple ID method)

The standard Archive > Distribute flow requires a paid account. Use this workaround instead.

**Step A: Disable code signing in Build Settings**

With the App target selected, open **Build Settings** and search for `signing`:

- Set **Code Signing Identity** (Debug and Release) to **Don't Code Sign**
- Clear **Development Team** to **None**

Click **+** then **Add User-Defined Setting** and add:

- `CODE_SIGNING_ALLOWED` = `NO`
- `CODE_SIGNING_REQUIRED` = `NO`

**Step B: Build for a real device**

In the top device selector, choose **Any iOS Device (arm64)**. Press **Cmd+B** and wait for **Build Succeeded**.

**Step C: Export as IPA**

In the Project Navigator, expand **Products**, right-click **App.app**, and choose **Show in Finder**. Then in Terminal:

```bash
APP_PATH="/path/to/App.app"   # paste the Finder path here

mkdir -p ~/Desktop/Payload
cp -r "$APP_PATH" ~/Desktop/Payload/
cd ~/Desktop
zip -r Relay.ipa Payload
rm -rf Payload
```

You now have `Relay.ipa` on your Desktop.

### 3.8 Install via SideStore

[SideStore](https://sidestore.io/) signs and installs the IPA using your free Apple developer certificate and refreshes it on-device. After the initial setup, no Mac is needed.

1. Install SideStore on your iPhone following the [SideStore docs](https://docs.sidestore.io/). Complete the one-time WireGuard pairing (requires a Mac).
2. AirDrop `Relay.ipa` to your iPhone. When prompted, save it to **Files** (it will not install automatically).
3. Open **SideStore**, go to **My Apps**, tap **+** (top right), and browse to the `.ipa` in Files.
4. SideStore signs and installs it.
5. Trust the certificate: **Settings > General > VPN & Device Management > your Apple ID > Trust**.

### 3.9 Import your identity file on iOS

**AirDrop method (recommended):**

1. AirDrop your `identity-NN.bin` file to your iPhone.
2. iOS will prompt "Open with Relay". Tap it.
3. The app saves the identity and reloads automatically.

**Files app method:**

1. Copy `identity-NN.bin` to iCloud Drive or the Files app.
2. Long-press the file, tap **Share**, then tap **Relay**.

### 3.10 Certificate refresh

SideStore auto-refreshes the 7-day signing certificate via WireGuard. No action is needed as long as SideStore is installed and the VPN is available periodically.

### 3.11 Rebuilding after changes

After editing the web app and wanting to update the iOS app:

```bash
cd relay-web && npm run build:mobile
cd ../relay-mobile && npx cap sync ios
```

Then repeat steps 3.7 and 3.8 to build a new IPA and install via SideStore.

---

## Quick reference


| Task                       | Where           | Command / action                                      |
| -------------------------- | --------------- | ----------------------------------------------------- |
| Generate 20 identities     | `relay-server/` | `node scripts/generate-20-identities.mjs`             |
| Seed allowed keys          | `relay-server/` | `npm run seed`                                        |
| Run API server             | `relay-server/` | `npm run start`                                       |
| Run expiry worker          | `relay-server/` | `npm run worker`                                      |
| Run web app                | `relay-web/`    | `npm run dev` (after `.env.local` and `identity.bin`) |
| Build mobile static export | `relay-web/`    | `npm run build:mobile`                                |
| Sync web assets to Xcode   | `relay-mobile/` | `npx cap sync ios` (or `npm run build` to do both)    |
| Open Xcode                 | `relay-mobile/` | `npm run open`                                        |


