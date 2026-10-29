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

- **Self-made identities, admin enrollment**: Each person's app makes their own keys; nobody else ever holds them. The admin enrolls people in person from a signed code and publishes an admin-signed member list that every app verifies. Anyone on the list can message anyone else on it.
- **One app, any server**: The app isn't tied to a server. Members join with a join code (QR or link) from their admin, which pins the server address and the admin keys the app will trust. One app can join several servers and switch between them.
- **Anonymous requests**: Members log in only to collect blind-signed tokens (RFC 9474). Sending, syncing and call setup each spend a token, so the server can tell a member is asking but not which one. The server keeps no request or IP logs.
- **E2EE messaging, sender and recipient hidden**: Each message or file is encrypted once and stored as blobs of one fixed size (64 KB by default; the admin can set 16–256 KB and up to how many random decoy blobs each send adds). Blobs carry no sender or recipient: every member downloads every blob and keeps what decrypts for them, so the server can't tell who wrote to whom, or text from files.
- **Voice/video**: Room-based WebRTC with Socket.io signaling. Mute, deafen, camera, screen share.
- **@mentions**: Type `@` to mention someone (or `@everyone` in a group). Mentions of you are highlighted, and the conversation shows an `@` badge until you read it.
- **Encrypted local history**: Messages are kept on your device, encrypted (with a key from your passphrase on desktop Chrome/Edge), for 7 days after the server drops them by default. **Settings → Storage** shows what's kept and clears files, a conversation, or everything.
- **72-hour blob expiry with timestamp obfuscation**: Blobs expire in a random window around 72 hours. Exact send time is not stored. A background worker deletes expired blobs.
- **Identity**: Keys are made on your device. On desktop Chrome/Edge they're saved to a passphrase-encrypted file in a folder you choose; elsewhere they stay in the app and can't be exported. Enrollment happens in person.
- **Customizable**: The UI runs locally. Edit it, rebuild, and your changes are live. The server is unaffected.
- **User-facing note:** Message *content* is intended to stay opaque to the relay. *Metadata* (who contacts whom, when, call participation, IPs from ICE) is still visible to the relay. Best mitigation: keep identity distribution off the public web, use a relay you trust, and verify contact keys out-of-band.

---

## Requirements


| Component        | Requirements                                                                          |
| ---------------- | ------------------------------------------------------------------------------------- |
| **relay-web**    | Node.js v18+ (v20+ recommended), npm                                                  |
| **relay-mobile** | macOS, Xcode 15+, Node.js v18+, npm, free Apple ID                                    |
| **relay-server** | Node.js v18+, npm, PostgreSQL.                                                                           |


---

## 1. Server setup (one-time, done by whoever hosts)

This is done once by the person running the server, who is also the first admin.

### 1.1 Create the admin identity

1. Open the web app (section 2).
2. On **Join a server**, choose **I'm setting up a new server**, enter your server's address (e.g. `https://relay.example.com`) and your display name. This creates your identity for that server.
3. The next screen shows your signing key. Put it in `ADMIN_SIGNING_KEYS` in the server's `.env` (below). It only authorizes the first member list; after that, admins are managed in the app.

### 1.2 Deploy the server

On the machine that will host the relay (e.g. a DigitalOcean droplet, VPS):

1. Copy `relay-server/` to the host (rsync, scp, git, etc.).
2. Install Node.js (v18+) and PostgreSQL. Create an empty database and a DB user.
3. Configure env:
  ```bash
   cp .env.example .env
   # Edit .env: DATABASE_URL, PORT (4000), HOST=127.0.0.1, PUBLIC_URL, ADMIN_SIGNING_KEYS, and the TURN_* values (see 1.4)
  ```
4. Install deps and create the schema:
  ```bash
   npm i
   npx prisma generate
   npx prisma db push
  ```
5. Start the relay:
  ```bash
   npm run start    # API + Socket.io (use PM2 for production: pm2 start src/index.js --name relay-api)
   npm run worker   # Deletes expired blobs (pm2 start src/worker.js --name relay-worker)
  ```
6. Back in the app, press **Create member list**. You're now enrolled.
7. Share the join code from **Settings → Admin** (QR or link) with each new member, in person or over a channel you already trust, then enroll them there.

`PUBLIC_URL` must match the address in your join code exactly: logins signed for any other address are refused. `TOKEN_RATE_PER_MINUTE` (default 30, after a burst of `TOKEN_BURST`, default 200) limits how fast each member gets anonymous tokens; one token pays for one send, sync or call setup. There's no daily cap.

**Upgrading:** each phase so far is a hard cutover (phase 5's message format can't read older blobs). Phase 4 replaced the plain `.bin` files with an encrypted `.relayid` file (desktop Chrome/Edge) or the app's own storage, and old files aren't read. Wipe the database (`npx prisma db push --force-reset`), then everyone joins with the join code, creates a new identity and gets enrolled again. Old `relay-web/public/identity/*.bin` files can be deleted.

### 1.3 HTTPS (required)

Clients must reach the relay over HTTPS. Point a domain's DNS record at the host, then put [Caddy](https://caddyserver.com/docs/install) in front of the API. It gets and renews the certificate itself:

```bash
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile   # edit relay.example.com to your domain
sudo systemctl reload caddy
sudo ufw allow 80/tcp && sudo ufw allow 443/tcp
```

With `HOST=127.0.0.1` the API's plain-HTTP port is only reachable through Caddy. Don't open port 4000 in the firewall.

### 1.4 TURN server (needed for cross-network calls)

WebRTC media is peer-to-peer. STUN works for some same-network setups, but calls across different networks or strict NATs need a TURN relay. Run coturn on the same host. Clients never get a fixed password: the API hands out credentials that expire (12 hours by default).

```bash
sudo apt install -y coturn
openssl rand -hex 32   # the shared secret
```

1. Copy `deploy/turnserver.conf` to `/etc/turnserver.conf`. Set `static-auth-secret` to the secret, and `realm` and the cert paths to your domain. If you skip TLS, comment out `tls-listening-port`, `cert` and `pkey`.
2. In `relay-server/.env`, set `TURN_SECRET` to the same secret and `TURN_URLS`/`STUN_URLS` to your domain, then restart the API.
3. Open the ports and start coturn:
  ```bash
   sudo ufw allow 3478 && sudo ufw allow 5349/tcp && sudo ufw allow 49152:65535/udp
   sudo systemctl enable coturn && sudo systemctl restart coturn
  ```

---

## 2. Web app setup (each user)

Each person sets up their own local copy of `relay-web`. Use Chrome or Edge on desktop to keep your identity as an encrypted file in a folder you choose.

### 2.1 Configure env (optional)

No configuration is needed: the app asks which server to join. A build can preset one server by setting both values in `relay-web/.env.local` (copy `.env.local.example`):

```env
NEXT_PUBLIC_API_URL=https://relay.example.com
NEXT_PUBLIC_ADMIN_SIGNING_KEYS=ADMIN_KEY_FROM_THE_HOST
```

TURN settings come from the relay at call time.

### 2.2 Join, create your identity, and get enrolled

1. **Join a server**: scan the admin's join QR, open their join link, or paste the code. Get it from the admin directly: it carries the admin keys your app will use to check the member list.
2. The app asks for a display name and creates your keys for that server. Each server gets its own identity, so servers can't link you. A popup explains where they're kept:
   - **Desktop Chrome/Edge:** pick a folder and a passphrase. Your identity is saved there as `relay-<server>.relayid`, encrypted with the passphrase, and the app asks for the passphrase each time it opens. Pick a local folder (not iCloud, Dropbox, OneDrive or a git repo) and keep a copy on a USB stick: losing the file or the passphrase means being enrolled again. On another computer, choose **I already have an identity file for this server**.
   - **Other browsers and phones:** the keys stay in the app's storage and can't be exported. Clearing the site's data or switching browsers loses them.
3. The app shows an enrollment QR and code that expire after 3 minutes. Meet the admin, let them scan it (or give them the code), and check the fingerprint they see matches yours. The app moves on by itself once you're enrolled.

Admins enroll, label and remove people, choose other admins, set the message blob size and decoys, and see server status in **Settings → Admin**.

To join another server, pick **+ Join another server…** in the server menu above your chats; the same menu switches between them. Each server has its own identity and tokens. **Settings → Leave server** removes you as a member right away and deletes that server's identity from the device; to come back you need a new join code and approval. The last admin can't leave.

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

Optional: the app asks for a join code on first run. To preset a server instead, set `NEXT_PUBLIC_API_URL` (and `NEXT_PUBLIC_ADMIN_SIGNING_KEYS`) in `relay-web/.env.local`; they're baked in at build time, and the URL must not be `localhost`.

```env
NEXT_PUBLIC_API_URL=https://relay.example.com
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

### 3.9 Create your identity on iOS

Open the app, join and create your identity, as in 2.2. It's kept in the app's own storage and can't be exported; deleting the app deletes it.

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
| Run API server             | `relay-server/` | `npm run start`                                       |
| Run expiry worker          | `relay-server/` | `npm run worker`                                      |
| Run web app                | `relay-web/`    | `npm run dev` (after `.env.local`)                    |
| Build mobile static export | `relay-web/`    | `npm run build:mobile`                                |
| Sync web assets to Xcode   | `relay-mobile/` | `npx cap sync ios` (or `npm run build` to do both)    |
| Open Xcode                 | `relay-mobile/` | `npm run open`                                        |


