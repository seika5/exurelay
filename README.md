# Relay

**End-to-end encrypted messages and voice/video calls for a small, closed group.** The server only relays
fixed-size encrypted blobs that carry no sender and no recipient. There's no public sign-up: an admin enrolls each
person in person, from a code their own device made.

```
relay/
├── relay-server/   Node.js API, Socket.io signaling and expiry worker. Hosted once.
├── relay-web/      The app: a static web app (PWA). Installed from the official build, a fork, or run locally.
└── .github/        Tests on every push; publishes relay-web to GitHub Pages.
```

See **[DESIGN.md](DESIGN.md)** for the threat model, cryptography, every design decision and the known gaps, and
**[FORKING.md](FORKING.md)** to run your own build of the app.

---

## Features

- **Self-made keys, in-person enrollment.** Each device makes its own keys; nobody else ever holds them. The admin enrolls people from a signed code shown on their screen and publishes an admin-signed member list that every app verifies.
- **Sender and recipient hidden from the server.** Each message or file is encrypted once and stored as blobs of one fixed size (64 KB by default; the admin sets 16–256 KB and up to how many random decoy blobs a send adds). No blob carries a sender, a recipient or any structure: every member downloads every blob and keeps what decrypts, so the server can't tell who wrote to whom, or text from files.
- **Anonymous requests.** Members log in only to collect blind-signed tokens (RFC 9474). Sending, syncing and call setup each spend one, so the server knows a member is asking but not which one. No request or IP logs.
- **Calls** (WebRTC, mute, deafen, camera, screen share) with signaling sealed end to end between the two devices, in random rooms announced only inside encrypted messages.
- **@mentions**, with a picker, highlighting and an unread badge, plus **push notifications only for @mentions and call rings**, encrypted device to device.
- **Linked devices.** Each device has its own keys. Link a new one from one you already have (no admin needed); unlink a lost one.
- **Encrypted local history**, kept 7 days after the server drops a message (adjustable), with **Settings → Storage** to clear files, a conversation or everything.
- **Your keys, your choice of place.** On desktop Chrome/Edge, a passphrase-encrypted identity file in a folder you pick; elsewhere, non-exportable keys inside the app.
- **One app, many servers.** Join several servers with join codes (QR or link) and switch between them; each server gets its own identity, so servers can't link you.
- **Customizable.** Sandboxed plugins (themes, custom message types, their own screens) in the official app, or fork it and change anything.
- **Expiry with blurred timing.** Blobs expire at a random time about 3–4 days after the day they were sent; exact send times are never stored.

What the server still sees: when uploads happen and how big each batch is, IP addresses, who is in a call room
together, and (for pushes) who is being mentioned or rung at that moment. DESIGN.md §1 and §9 go into this.

---

## 1. Hosting a server (once, by the first admin)

You need two things: the **server** (`relay-server`, on a host you control) and the **app** somewhere people can
open it (GitHub Pages, the same host via Caddy, or a local copy; see section 2). The first admin's own identity has
to exist before the server's first start, because the server needs its signing key once.

| Needs | |
| --- | --- |
| A Linux host with a domain name pointing at it | e.g. a small VPS; `relay.example.com` below |
| Node.js 20+, PostgreSQL, Caddy (HTTPS), coturn (calls across networks) | configs in `relay-server/deploy/` |

### 1.1 Prepare the host

```bash
sudo apt install -y postgresql
sudo -u postgres createuser --pwprompt relay      # choose a password
sudo -u postgres createdb --owner relay relay
```

Install Node.js 20+ and [Caddy](https://caddyserver.com/docs/install), and copy `relay-server/` to the host
(git clone, rsync, …).

### 1.2 Open the app and create your admin identity

Open the app: the hosted one if it's already published (section 2.1), or your own copy (section 2.8, e.g.
`npm run dev` on your computer). Choose **I'm setting up a new server**, enter the server's address exactly as it
will be reached (e.g. `https://relay.example.com`) and your name. The next screen shows your **signing key**: copy it.
It only authorizes the first member list; after that, admins are managed in the app.

### 1.3 Configure and start the server

```bash
cd relay-server
cp .env.example .env
```

In `.env`, set at least:

| Setting | Value |
| --- | --- |
| `DATABASE_URL` | `postgresql://relay:PASSWORD@127.0.0.1:5432/relay` |
| `HOST`, `PORT` | `127.0.0.1` and `4000` (only Caddy talks to it) |
| `PUBLIC_URL` | the address from 1.2, e.g. `https://relay.example.com` (must match exactly: logins signed for any other address are refused) |
| `ADMIN_SIGNING_KEYS` | the signing key from 1.2 |
| `TURN_*` | see 1.6 |
| `VAPID_*` | optional, for push notifications: `npm run vapid` prints a key pair; set `VAPID_SUBJECT` to a `mailto:` you read |

Then:

```bash
npm ci
npx prisma generate
npx prisma db push
npm run start    # API + Socket.io; for production: pm2 start src/index.js --name relay-api
npm run worker   # deletes expired blobs;         pm2 start src/worker.js --name relay-worker
```

`TOKEN_RATE_PER_MINUTE` (default 30, after a burst of `TOKEN_BURST`, default 200) limits how fast each member gets
anonymous tokens; one token pays for one send batch, sync page or call setup.

### 1.4 HTTPS (required)

Put Caddy in front of the API; it gets and renews the certificate:

```bash
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile   # change relay.example.com to your domain
sudo systemctl reload caddy
sudo ufw allow 80/tcp && sudo ufw allow 443/tcp
```

With `HOST=127.0.0.1`, the API's plain-HTTP port is only reachable through Caddy. Don't open port 4000. The same
Caddyfile has an optional block to serve the app from this host too (`app.relay.example.com`).

### 1.5 Enroll yourself, then everyone else

Back in the app, press **Create member list**: you're enrolled and the server is live. In **Settings → Admin**, share
the join code (QR or link) with each new member in person or over a channel you already trust. They open it, create
their identity (section 2.4), and you scan or paste the code their app shows. Check the fingerprint matches.

### 1.6 TURN (calls across networks)

Calls are peer to peer; across different networks or strict NATs they need a TURN relay. Run coturn on the same host.
Clients get credentials that expire (12 hours by default), never a fixed password.

```bash
sudo apt install -y coturn
openssl rand -hex 32   # the shared secret
```

1. Copy `deploy/turnserver.conf` to `/etc/turnserver.conf`; set `static-auth-secret` to the secret, and `realm` and the certificate paths to your domain.
2. In `.env`, set `TURN_SECRET` to the same secret and `TURN_URLS`/`STUN_URLS` to your domain; restart the API.
3. `sudo ufw allow 3478 && sudo ufw allow 5349/tcp && sudo ufw allow 49152:65535/udp`, then `sudo systemctl enable --now coturn`.

### 1.7 Upgrading

Every phase so far has been a hard cutover: the message format, identity storage and member list changed in ways old
data can't follow. Wipe the database (`npx prisma db push --force-reset`), then everyone joins with the join code,
creates a new identity and is enrolled again.

---

## 2. Getting the app

### 2.1 Hosted (recommended)

The app is static files. The workflow in `.github/workflows/deploy-web.yml` tests it, builds it and publishes it to
GitHub Pages on every push to `main` (one-time: repository **Settings → Pages → Source: GitHub Actions**). Each build
publishes its git commit and a SHA-256 of every file; the app shows both in **Settings → General**, so people can
check what they're running. Any static HTTPS host works the same way (`npm run build`, then publish `relay-web/out/`),
including your relay host's own Caddy (the optional block in `relay-server/deploy/Caddyfile`).

### 2.2 On a phone: install it

On a phone, Relay only sets up inside the installed app (a browser tab has separate storage, so an identity made
there wouldn't be in the app):

- **iPhone/iPad (iOS 16.4+):** open the app's address in Safari → Share → **Add to Home Screen** → open Relay from the Home Screen.
- **Android:** open it in Chrome → ⋮ → **Install app** → open Relay from the Home Screen.

If you have a join link, open it again in the installed app (or paste its code there). Deleting the Home Screen icon
deletes the app's data, including its keys; link another device (2.5) so that isn't the end of your account.

### 2.3 On a computer

Use the hosted address in Chrome or Edge, ideally installed (the install icon in the address bar). There your
identity can be a passphrase-encrypted file in a folder you choose (2.4). Firefox and Safari work too, with keys
kept in the browser.

### 2.4 Join, create your identity, get enrolled

1. **Join a server**: scan the admin's join QR, open their link, or paste the code. Get it from the admin directly: it carries the admin keys your app will use to check the member list.
2. Enter your name. A popup explains where your keys will live:
   - **Desktop Chrome/Edge:** a folder and a passphrase. Your identity is saved there as `relay-<server>.relayid`, encrypted with the passphrase, which the app asks for each time it opens. Pick a local folder (not iCloud, Dropbox, OneDrive or a git repo) and keep a copy on a USB stick: losing the file or the passphrase means being enrolled again. On another computer, choose **I already have an identity file for this server**.
   - **Phones and other browsers:** the keys stay in the app and can't be exported.
3. The app shows an enrollment code (QR and text) that renews every 3 minutes. Meet the admin, let them scan it, and check the fingerprint they see matches yours. The app moves on by itself once you're in.

To join another server, pick **+ Join another server…** in the server menu above your chats; the same menu switches
between them. **Settings → Leave server** removes you as a member right away and deletes that server's identity from
the device. The last admin can't leave.

### 2.5 Your other devices

Each device has its own keys. To add one: on the new device, join the server and create an identity as above; on a
device you already have, go to **Settings → Devices**, scan or paste the new device's code, check the fingerprint and
name it. The new device opens by itself. Lost one? Unlink it from another. A new device doesn't get old messages.
Admins: admin works from one device at a time; move it with **Make admin device** (and before unlinking that device).

### 2.6 Notifications

**Settings → General → Turn on notifications** (on iPhone, in the installed app). Only @mentions and call rings
notify; everything else waits until you open the app. Rings come from **Notify** on a "not in call" tile.

### 2.7 Plugins

**Settings → Plugins** installs a plugin from a URL or a file, shows its SHA-256 for you to check, and pins that
exact code. Plugins run sandboxed (no keys, no stored messages, no network) and anything they send needs your OK.
Plugins never touch how messages are encrypted or sent. The API is described in `relay-web/src/lib/plugins.ts`.

### 2.8 Run your own copy locally

```bash
cd relay-web
npm ci
npm run dev                    # development, http://127.0.0.1:3000
npm run build && npm start     # the production build (static files, with its CSP), http://127.0.0.1:3000
```

To change more than plugins allow, see [FORKING.md](FORKING.md) and `relay-web/README.md`.

---

## Quick reference

| Task | Where | Command |
| --- | --- | --- |
| Run the API | `relay-server/` | `npm run start` |
| Run the expiry worker | `relay-server/` | `npm run worker` |
| Make push (VAPID) keys | `relay-server/` | `npm run vapid` |
| Server tests | `relay-server/` | `npm test` |
| Run the app (development) | `relay-web/` | `npm run dev` |
| Build the app (static, with CSP and build.json) | `relay-web/` | `npm run build` |
| Serve the build locally | `relay-web/` | `npm start` |
| App tests (including protocol vectors) | `relay-web/` | `npm test` |
| Redraw the icons | `relay-web/` | `python3 scripts/icons.py` |
