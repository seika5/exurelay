# Exurelay

**End-to-end encrypted messages and voice/video calls for a small, closed group.** The server only relays
fixed-size encrypted blobs that carry no sender and no recipient. There's no public sign-up: an admin enrolls each
person in person, from a code their own device made.

**The official app is at [exurelay.com](https://exurelay.com).**

```
exurelay/
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
open it (GitHub Pages, the same host via Caddy, or a local copy; see section 2). An Ubuntu 22.04 or 24.04 host
with 1 GB of RAM is plenty for a small group.

`relay-server/deploy/install.sh` sets up everything on that host: PostgreSQL, Node.js, Caddy (HTTPS), coturn
(TURN for calls), the secrets, system services that restart on failure, nightly backups (without messages) and
security updates. You choose a **one-time setup code** that lets you claim the server from the app. Pick one of the
three ways to run it (1.1), then claim the server (1.2).

### 1.1 Create the server

**Amazon Lightsail (CloudFormation).** [**Launch Stack**](https://console.aws.amazon.com/cloudformation/home#/stacks/quickcreate?templateURL=https://seika5-relay-templates.s3.us-east-2.amazonaws.com/aws-lightsail.yaml&stackName=relay)
opens CloudFormation with the template filled in (pick the region you want first, top right). Or open
**CloudFormation → Create stack → With new resources** and upload `relay-server/deploy/aws-lightsail.yaml`. Make up a
**SetupCode** (8+ characters) and choose an instance size (default `micro_3_0`, 1 GB). Leave **Domain** empty for
a free address (1.3). The stack creates the instance, a static IP and the firewall ports. Its **Outputs** tab
shows the `ServerAddress`.

**DigitalOcean, EC2, Hetzner, Vultr… (user data).** Create an Ubuntu 22.04/24.04 server and paste
`relay-server/deploy/cloud-init.sh` into its user data box (DigitalOcean: **Advanced options → Add
initialization scripts**), with your setup code in `RELAY_SETUP_CODE`. Open ports 22, 80, 443, 3478 (TCP and UDP), 5349/TCP and 49152–65535/UDP in the
provider's firewall if it has one. On AWS EC2, attach an Elastic IP so the address doesn't change when the
instance stops.

**A server you already have.**

```bash
git clone https://github.com/seika5/exurelay.git /tmp/exurelay
sudo bash /tmp/exurelay/relay-server/deploy/install.sh                 # free sslip.io address
sudo bash /tmp/exurelay/relay-server/deploy/install.sh --domain relay.example.com   # or your own domain
```

Add `--setup-code 'your-code'` to choose the code, or let it generate one and print it at the end.

User data and CloudFormation run the install on first boot, which takes about 5 minutes (log:
`/var/log/relay-install.log`). You can go straight to 1.2: the app waits until the server is up. If you left the
setup code empty, SSH in (Lightsail: the instance's **Connect** button): until the server is claimed, the login
message shows its address and setup code.

### 1.2 Claim it in the app and enroll everyone

1. Open the app: the official one at [exurelay.com](https://exurelay.com) (section 2.1) or your own copy (section 2.8).
2. Choose **I'm setting up a new server**, enter the server's address (e.g. `https://203-0-113-5.sslip.io`) and your name. If the server is still installing, the app says so and carries on by itself once it answers.
3. Enter the setup code and press **Create member list**. You're enrolled as the admin and the code stops working. Whoever enters it first becomes the admin, so keep it to yourself until then.
4. In **Settings → Admin**, share the join code (QR or link) with each new member in person or over a channel you already trust. They open it, create their identity (section 2.4), and you scan or paste the code their app shows. Check the fingerprint matches.

### 1.3 The address: free sslip.io, or your own domain

Browsers only let the app talk to a server over HTTPS, and certificates are issued for names. By default the
installer uses a free [sslip.io](https://sslip.io) name built from the server's IP (`203.0.113.5` becomes
`203-0-113-5.sslip.io`), so there's nothing to buy or configure. The trade-offs:

- **The name is the IP.** A new IP is a new address: members join it as a new server and are enrolled again. Cloud servers keep their IP (DigitalOcean droplets for life, Lightsail and EC2 with a static/Elastic IP), so this only bites when you move to a new server.
- **sslip.io answers for your name.** If it went down, new connections would fail; if it turned malicious, it could point your name elsewhere. Messages stay end-to-end encrypted and the join code pins the admin keys, so it could see when people connect, not what they say.

**Using your own domain** (survives a move to a new server, and doesn't depend on sslip.io):

1. At your DNS provider, add an **A record** for the name (e.g. `relay.example.com`) pointing at the server's IP. On Lightsail, that's the stack's `StaticIp` output.
2. Install with it: `install.sh --domain relay.example.com`, `RELAY_DOMAIN="relay.example.com"` in `cloud-init.sh`, or the **Domain** parameter of the CloudFormation stack. Create the record first or straight after; HTTPS starts working once it resolves.
3. Switching an existing server from sslip.io to a domain later: add the record, then rerun `sudo bash /opt/relay/relay-server/deploy/install.sh --domain relay.example.com`. The address changes, so to every app it's a new server: share the new join code from Settings → Admin and enroll everyone again.
4. Moving to a new server later: restore a backup on the new one with the same `--domain` (1.7) and point the record at it; members keep their join codes and nobody enrolls again.

### 1.4 Upgrading

```bash
sudo bash /opt/relay/relay-server/deploy/install.sh
```

It pulls the latest code, keeps the address and every secret, and restarts the services.

Upgrading to the version with sealed names (DESIGN.md §4 "Names") deletes the old plain-text names from the
server; each app sends its name again, encrypted, the next time it opens. A device linked before that upgrade still
has its name in its public certificate: unlink it and link it again (Settings → Devices) to remove it.

Every phase so far has been a hard cutover: the message format, identity storage and member list changed in ways
old data can't follow. If the installer stops because the database schema changed, wipe it
(`cd /opt/relay/relay-server && sudo -u relay npx prisma db push --force-reset`), rerun the installer, and
everyone joins with the join code, creates a new identity and is enrolled again.

### 1.5 What the installer sets up

| Piece | Where |
| --- | --- |
| Code | `/opt/relay` (a git checkout), run as the `relay` user |
| Settings and secrets | `/opt/relay/relay-server/.env` (database password, TURN secret, push keys, setup code). See `.env.example` for every setting, e.g. `TOKEN_RATE_PER_MINUTE` |
| Services | `relay-api` (API + Socket.io on `127.0.0.1:4000`), `relay-worker` (deletes expired blobs), `caddy`, `coturn`, `postgresql`. Logs: `journalctl -u relay-api` |
| HTTPS | `/etc/caddy/Caddyfile`, from `deploy/Caddyfile`; certificates from Let's Encrypt, renewed by Caddy |
| TURN | `/etc/turnserver.conf`, from `deploy/turnserver.conf`; `relay-turn-certs.timer` copies Caddy's certificate for it twice a day. Clients get credentials that expire (12 hours), never a fixed password |
| Firewall | ports added to `ufw` only if it's on; cloud firewalls (Lightsail's comes from the template) are separate |
| Backups | `relay-backup.timer`, nightly into `/var/backups/relay` (14 kept). See 1.7 |
| Updates | `unattended-upgrades`: security updates daily, and a reboot at 04:30 (server time) when one needs it. Exurelay itself updates only when you rerun the installer (1.4) |

### 1.6 Setting it up by hand

Without the installer, on any Linux host:

1. **Database:** `sudo apt install -y postgresql`, then `sudo -u postgres createuser --pwprompt relay` and `sudo -u postgres createdb --owner relay relay`.
2. **Code:** install Node.js 20.12+ and copy `relay-server/` to the host, then `npm ci`, `npx prisma generate` and `npx prisma db push`.
3. **Settings:** `cp .env.example .env` and set `DATABASE_URL`, `HOST=127.0.0.1`, `PORT=4000` and `PUBLIC_URL` (the exact `https://` address: logins signed for any other address are refused). The server reads `.env` itself.
4. **Admin:** in the app, choose **I'm setting up a new server**, open **Set the server up by hand instead?** and copy the signing key into `ADMIN_SIGNING_KEYS` (or set `SETUP_CODE` to a long random string and enter that instead).
5. **Run:** `npm run start` and `npm run worker` (for production, as services or with pm2).
6. **HTTPS:** install [Caddy](https://caddyserver.com/docs/install), copy `deploy/Caddyfile` to `/etc/caddy/Caddyfile` with your name in place of `relay.example.com`, `sudo systemctl reload caddy`, and open ports 80 and 443. Don't open port 4000. The same Caddyfile has an optional block to serve the app from this host too.
7. **TURN:** `sudo apt install -y coturn`, copy `deploy/turnserver.conf` to `/etc/turnserver.conf` and set `static-auth-secret` (from `openssl rand -hex 32`), `realm` and the certificate paths; behind NAT (AWS) add `external-ip=PUBLIC/PRIVATE`. In `.env`, set `TURN_SECRET` to the same secret and `TURN_URLS`/`STUN_URLS` to your name. Open 3478, 5349/TCP and 49152–65535/UDP, then `sudo systemctl enable --now coturn`.
8. **Push (optional):** `npm run vapid` prints `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`; set `VAPID_SUBJECT` to a `mailto:` or your `https://` address.
9. Restart the API, then continue from 1.2 step 3 (with an empty setup code if you used `ADMIN_SIGNING_KEYS`).

### 1.7 Backups and moving a server

Each night `relay-backup` saves what would be painful to rebuild: the member list, enrolled devices and
revocations, profiles, push subscriptions and the server's `.env` (TURN secret, push keys, database password).
Without it, a lost server means everyone enrolls again.

**Messages are never in a backup.** They're end-to-end encrypted and the server deletes them after 3–4 days; a
backup that kept them would break that promise. For the same reason, **don't turn on your provider's disk
snapshots** (Lightsail automatic snapshots, EBS snapshots, DigitalOcean backups): they copy the whole disk,
messages included, and keep it for days or weeks.

The backups sit on the server itself, so they don't survive losing it. Copy the latest one somewhere private
(it holds the server's secrets) now and then:

```bash
ssh ubuntu@203.0.113.5 'sudo cat /var/backups/relay/latest.tar.gz' > relay-backup.tar.gz
```

Run `sudo relay-backup` for one right now. To restore, or to move to a new server, copy the file there and:

```bash
sudo bash relay-server/deploy/install.sh --restore relay-backup.tar.gz [--domain relay.example.com]
```

With your own domain, point its record at the new server and everyone carries on. With an sslip.io address the
new server has a new address, and apps keep one identity per address, so it's a new server to them: share the new
join code (Settings → Admin) and enroll everyone again. Use your own domain if you expect to move.
Messages waiting on the old server aren't moved: send anything important again after the move.

### 1.8 Publishing a Launch Stack link (maintainers and forks)

CloudFormation opens a template from a link only if it's in S3. `.github/workflows/publish-template.yml` uploads
`aws-lightsail.yaml` to a public bucket on each change, with its `RepoUrl` set to your repository, and prints the
link in the run summary. One-time setup, with the AWS and GitHub CLIs signed in:

```bash
bash .github/setup-template-publishing.sh        # bucket <github-owner>-relay-templates
```

It creates the bucket (only the template is public), an IAM role only your `main` branch can assume and only to
upload that file, and the repository variables `TEMPLATE_BUCKET` and `AWS_TEMPLATE_ROLE_ARN`, then uploads the
template once. The bucket goes in `us-east-2` unless you set `RELAY_TEMPLATE_REGION`. In a fork, change the Launch
Stack link in 1.1 to your bucket. The link looks like:

```text
https://console.aws.amazon.com/cloudformation/home#/stacks/quickcreate?templateURL=https://BUCKET.s3.REGION.amazonaws.com/aws-lightsail.yaml&stackName=relay
```

---

## 2. Getting the app

### 2.1 Hosted (recommended)

Use the official app at **[exurelay.com](https://exurelay.com)**: it's built from this repository's `main` by the
workflow below, and works with any Exurelay server.

The app is static files. The workflow in `.github/workflows/deploy-web.yml` tests it, builds it and publishes it to
GitHub Pages on every push to `main` (one-time: repository **Settings → Pages → Source: GitHub Actions**, plus
**Custom domain** for your own address). Each build
publishes its git commit and a SHA-256 of every file; the app shows both in **Settings → General**, so people can
check what they're running. Any static HTTPS host works the same way (`npm run build`, then publish `relay-web/out/`),
including your relay host's own Caddy (the optional block in `relay-server/deploy/Caddyfile`).

### 2.2 On a phone: install it

On a phone, Exurelay only sets up inside the installed app (a browser tab has separate storage, so an identity made
there wouldn't be in the app):

- **iPhone/iPad (iOS 16.4+):** open the app's address in Safari → Share → **Add to Home Screen** → open Exurelay from the Home Screen.
- **Android:** open it in Chrome → ⋮ → **Install app** → open Exurelay from the Home Screen.

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
name it. The new device opens by itself. Lost one? Unlink it from another. A new device doesn't get old messages,
and shows someone's name once one of their devices has been online since (their key fingerprint until then).
Device names are only ever seen by your own devices.
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
| Install or upgrade a server | the host | `sudo bash relay-server/deploy/install.sh [--domain NAME] [--setup-code CODE]` |
| Back up now / restore | the host | `sudo relay-backup` / `install.sh --restore FILE` |
| Run the API | `relay-server/` | `npm run start` |
| Run the expiry worker | `relay-server/` | `npm run worker` |
| Make push (VAPID) keys | `relay-server/` | `npm run vapid` |
| Server tests | `relay-server/` | `npm test` |
| Run the app (development) | `relay-web/` | `npm run dev` |
| Build the app (static, with CSP and build.json) | `relay-web/` | `npm run build` |
| Serve the build locally | `relay-web/` | `npm start` |
| App tests (including protocol vectors) | `relay-web/` | `npm test` |
| Redraw the icons | `relay-web/` | `python3 scripts/icons.py` |
