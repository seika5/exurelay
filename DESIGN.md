# Relay design and security decisions

This is the single place for *why* Relay works the way it does: the threat model, the deliberate trade-offs, the decisions made but not built yet, and known gaps. Setup steps live in [README.md](README.md). When you change behavior described here, update this file in the same change.

Each decision has a status:

- **Current**: how the code works today, intended.
- **Decided**: agreed direction, not implemented yet.
- **Open**: needs a decision.
- **Gap**: current behavior that contradicts the goals below; fix it.

---

## 1. Goals and threat model

Relay is messaging and calls for a closed, invite-only group. It started with a fixed set of 20 accounts and is moving to any number of enrolled members (§4).

| Party | What they should learn | What they should be able to do |
| --- | --- | --- |
| Relay server / host | Ideally nothing beyond "some member is online" and blob counts/sizes | Store and forward opaque data; keep non-members out |
| Network observer | Nothing beyond "this IP talks to the relay" | Nothing |
| Outsider who knows a key hash | Nothing | Nothing |
| Another member | Only what was sent to them | Message/call any member; see only their own conversations |
| Whoever hosts a web app build (official or fork) | Same as server, but **they serve the code**, so they are fully trusted by that build's users | n/a |

Out of scope: a compromised device, a malicious build or plugin the user chose to install, traffic analysis by a global observer.

### Two levels of server adversary

Every request reaches the server from an IP address. A typical member's IP is stable and shared across all their requests, including the identified ones (login, admin). So an operator who **logs IPs and timing** can tie "anonymous" requests back to a member. Relay therefore promises different things against two kinds of server:

| Server adversary | Example | What Relay protects |
| --- | --- | --- |
| **Data at rest** | Database dump, seized disk, a curious admin browsing tables | Content, senders, recipients, who was notified. Nothing identifying is *stored* (§5, §9). |
| **Actively malicious operator** | Logs IPs and timing for every request | Content only. Senders, recipients, notification targets and online times can be inferred from IPs and timing unless members hide their IP (VPN/Tor-style relay). |

Any measure that only hides something from the second kind of adversary *without* IP hiding gives a false sense of security, so it's marked as such or not built. The server code must not log IPs or request details, and the operator must keep it that way.

---

## 2. Components

| Component | Role | Trust |
| --- | --- | --- |
| `relay-server/` | Express + Socket.io + Postgres. Stores fixed-size encrypted blobs, relays WebRTC signaling, runs the expiry worker. | Untrusted for content, trusted for availability |
| `relay-web/` | Next.js client. All crypto happens here. Can run locally, as the official PWA, or as a user's own deployed fork. | Trusted (by whoever runs that build) |
| Official PWA | **Decided.** The owner-hosted build of `relay-web`. Its core can't be changed by users; plugins can extend it (§9). | Trusted by whoever installs it |
| Forked builds | **Decided.** Users fork `relay-web` and deploy it to their own HTTPS origin for full control (§9). | Trusted by their owner |
| `relay-mobile/` | Capacitor iOS wrapper, sideloaded via SideStore. | **Decided: remove**, replaced by the PWA, plugins and forks |

---

## 3. Cryptography (current)

| Piece | Choice | Notes |
| --- | --- | --- |
| Identity key | ECDH P-256 (Web Crypto) | ~128-bit security level, the same class as TLS and Signal's Curve25519 |
| Key hash / address | SHA-256 hex of the base64 raw public key | Public identifier; **not a secret** |
| Per-message key | HKDF-SHA256 over the static-static ECDH secret, salt `Relay-E2EE-v1`, info = 16-byte messageId | New key per message |
| Content cipher | AES-256-GCM, random 96-bit IV, 128-bit tag, messageId as AAD | Authenticated encryption |
| Blob | Exactly 65,536 bytes, zero-padded; larger payloads are chunked | Hides message length up to 64 KB |
| Sender authentication | Implicit: only the sender or recipient can compute the ECDH key. The client checks that the key that encrypted the blob belongs to the `senderKeyHash` it claims (§8, fixed). | Deniable (no signatures) |

**Effective strength:** 128-bit, bounded by P-256. AES-256 doesn't raise it, but it costs nothing.

**Known-plaintext patterns:** Every message has predictable JSON (`{"messageId":...,"chunkIndex":0,...}`) and often a predictable sender hash. This does **not** help an attacker recover keys. AES-GCM is designed to resist known- and chosen-plaintext attacks, each message gets its own HKDF key, and IVs are random. Making plaintext "less predictable" adds nothing, so don't spend effort there. The real leaks are below.

**Known limitations (Current, documented):**

- **No forward secrecy.** Static-static ECDH means anyone holding `identity.bin` can decrypt every blob still on the server (up to ~4 days) and any ciphertext recorded earlier. A ratchet (e.g. Double Ratchet) would fix this; it's a large change. **Open.**
- **Not post-quantum.** Ciphertext harvested now could be decrypted by a future quantum computer. Hybrid ML-KEM isn't in Web Crypto on all target browsers yet. **Open, low priority.**
- **Volume leaks.** Blob count reveals rough size (1 blob ≈ text, many ≈ file), and POST timing reveals activity.
- A legacy v0 packet format (no AAD, no per-message key) is still accepted on read. It goes away at the hard cutover (§4).

---

## 4. Identity and enrollment

| Decision | Status |
| --- | --- |
| The host runs `generate-20-identities.mjs`, so **the host holds every private key** and can decrypt everything. | **Current, being replaced** |
| Each user generates their own keypair on their own device. Only the public key/hash is shared, in person. | **Decided** |
| Move off the fixed 20 accounts to any number of enrolled members. The identity file's `myUserNumber` (1–20) goes away. | **Decided** |
| `identity.bin` is a custom binary file (v4) holding: your key hash, public key and private key (JWK); every contact's key hash, public key, display name and call volume; and your user number (1–20). Losing it means losing the account and the contact list. | Current |
| Group names aren't in the file. They come from `group_rename` messages, so today they disappear when those blobs expire. | Current → kept in the local cache (§5) |
| Contacts are exchanged in person to prevent MITM, one pair at a time (n² meetings for n people). | **Current → Decided: replace** with the admin-signed directory (below) |
| Who enrolls and removes members: the **host (admin)**, from an admin tab in Settings. | **Decided** (below) |

### Decided: no backups

- Keys are generated in the app and live only in that app's storage (IndexedDB). There is no export button and no backup file. Relay doesn't use iCloud for anything.
- **Losing the identity** (new phone, deleting the Home Screen icon, clearing site data) means the account is gone: the admin removes the old member, enrolls a new key, and contacts are re-exchanged in person. Messages from the last ~4 days can't be recovered, because they were encrypted to the old key.
- **No migration:** the old `.bin` format, the fixed-20 identities and blob format v0/v1 are deprecated entirely. The new version is a hard cutover: the server is wiped, and everyone generates new keys and is enrolled again.

### Decided: linked devices (one account, several devices)

Because everyone downloads every blob, a second device with the same key automatically receives everything. So linking means copying the identity securely:

1. **Link:** on the new device (any build: official PWA or a fork), choose "Link to existing account". It shows a QR with a one-time public key, valid for 3 minutes.
2. **Approve:** on an existing device, scan it. The app shows a short code to compare on both screens, encrypts the identity (keys + contacts + settings) to the one-time key, and sends it through the relay as an ordinary blob.
3. The new device decrypts it and wipes the one-time key. Both devices now act as the same member.
4. **Staying in sync:** contact, name and setting changes go to your other devices as encrypted self-messages. Each device keeps its own cache; self-copies of sent messages appear everywhere.
5. **Push:** each device registers its own push endpoint, and a mention notifies all of them.
6. **Device list:** Settings shows your linked devices by name. Unlinking a device you still hold wipes its local data.
7. **Lost or stolen device:** it holds the private key, so the safe fix is a new key. The admin removes the old key and enrolls a new one, and contacts are re-verified in person. (Per-device keys, where each device has its own key under one account, would make this easier but multiply every message by the device count. Not planned.)

### Decided: admin tab

- The server config lists the admin public key(s); the host is the first admin. The Settings → **Admin** tab appears only when the server confirms, at login, that this identity is an admin. Admin actions use identified, signed requests.
- **Members:** list members by the admin's own labels and key fingerprints, plus enrolled date. There is no last-seen field: the server doesn't track it.
- **Enroll:** scan the newcomer's QR or paste their public-key code, in person, and set a label (stored server-side, visible only to admins).
- **Remove/revoke:** delete the member so they can no longer log in. Anonymous tokens must expire quickly (issuer key rotated e.g. daily) so a removed member's leftover tokens stop working. The server publishes a signed list of removed keys, and clients grey out those contacts.
- **Server status:** blob count, storage used, token quotas, TURN status. No per-member activity.
- Adding more admins is possible; admins can't read anyone's messages.

### Decided: admin-signed member directory

Pairwise QR exchange needs a meeting for every pair. Instead, the in-person step happens once per member, with the admin at enrollment, and the admin vouches for everyone:

1. **Directory:** the server publishes the member list (public keys + each member's self-chosen display name, signed by that member), and the whole list is signed by an admin key. Clients verify both signatures, so the server alone can't insert or swap a key.
2. **Contacts:** every directory member is a contact. **Anyone can message anyone** in the directory; messages from keys that aren't in it are dropped.
3. **No rollback:** the signed directory carries an increasing version number, and clients refuse a version older than the newest they've seen. That stops a hacked server from replaying an old directory (e.g. one from before a removal). It's cheap, so it stays.
4. **Key changes** (re-enrollment after a lost device) show a notice in conversations with that person.
5. **Removals** come from the same signed directory, so removed members are greyed out (§4 admin tab) and their key-rotation entry is verifiable (§6).

**Trust:** the admin is fully trusted. A compromised admin, or a compromised member device, is game over for whatever it can reach, and no extra verification tiers or cross-checks are built for that. The admin key lives on the admin's device, not on the server, so **hacking the server alone** still can't add or swap keys.

Enrollment: the new user's app generates keys and shows a QR/short code containing its public key, a timestamp, and a signature over both. The admin scans it in person, and the server adds the key to the member list. **All QR codes** (enrollment, device linking) **expire after 3 minutes**: a photographed or leaked code can't be replayed later, and the signature proves the presenter holds the key. The server stores **public keys** (not just hashes) so it can verify logins (§6).

---

## 5. Message storage and metadata

| Decision | Status |
| --- | --- |
| Blobs are fixed 64 KB, stored ≤ ~96 h: expiry = UTC midnight of the send day + 72 h + random 0–24 h. Exact send time is never stored. | Current |
| No local message history; clients re-download and decrypt everything (including a self-addressed copy of their own messages). History ends when blobs expire. | **Current → Decided: replace** with an encrypted local cache (below) |
| Server addresses each blob by **recipient key hash**. | **Current → Decided: remove** (recipient-blind storage, below) |
| The sender's public key is in **plaintext** in every blob header, so the server (and, today, anyone who can GET blobs) learns sender→recipient for every message. | **Gap → Decided: hide sender** |

### Decided: sealed sender

Encrypt the outer layer to the recipient using a **fresh one-time key** (ECIES-style), and put the real sender key inside the ciphertext. The recipient still authenticates the sender using the static-static ECDH key on the inner layer. The server then stores a blob with nothing about who sent it.

### Decided: recipient-blind storage ("everyone fetches everything")

Drop the recipient field too. Every member downloads every message blob and tries to decrypt it. Trial decryption is one ECDH per blob (well under a millisecond), so CPU isn't the issue; **bandwidth is**, and it grows with the number of members:

`daily download per member ≈ members × messages per member per day × blobs per message × 64 KB`

| Example | Per member, per day |
| --- | --- |
| 20 members × 5 messages × 3 blobs (recipients + self copy) | ≈ **19 MB** |
| 100 members, same habits | ≈ **96 MB** |
| First sync after 4 days away, 20 members | ≈ 77 MB |

Shape:

1. Fetch-all only for *message* blobs, with an incremental cursor (`since=<last id>`) so each blob is downloaded once.
2. Store file attachments as separate blobs that the message points at by id + key. Only the real recipient fetches them.
3. Notifications use targeted push (§9).
4. Consider smaller fixed buckets (e.g. 4 KB for text, 64 KB for attachment chunks) to cut bandwidth.
5. **Open, for larger groups:** split blobs into K buckets by a rotating recipient tag. Each member then fetches only their bucket, which cuts bandwidth by K but shrinks the crowd a recipient hides in from N to about N/K.

Even without a recipient field, the server must still keep non-members out (§6).

### Decided: encrypted local cache

With fetch-all, re-downloading the whole window on every launch would cost up to ~77 MB, so clients keep a local cache:

- **What's stored:** the sync cursor, the ids of blobs already processed (including ones that weren't for us, so they're never re-downloaded), decrypted messages, and downloaded attachments.
- **At rest:** encrypted with a random AES-256-GCM cache key, kept as a non-extractable `CryptoKey` in IndexedDB. The cache data itself is also in IndexedDB.
- **Self-copies:** keep sending them, so a cleared cache can recover your own messages from the last ~4 days.
- **Settings → Storage tab:**
  - Show the size used, split into messages and attachments.
  - Retention: N days, **default 7**, counted from the blob's server `expiresAt` (which already includes the 72 h + 0–24 h jitter). A message is removed locally at `expiresAt + N days`, about 10–11 days after it was sent. Basing it on `expiresAt` rather than `sentAt` means local deletion times carry the same jitter and don't pin down the exact send time.
  - Clear attachments only, clear one conversation, or clear everything.
  - "Re-sync from server": wipe the cache and re-download what the server still has.
  - Logging out or removing the identity wipes the cache and its key.

### Decided: delete for me

This is a required feature: no delete exists in the app today, and it ships with protocol v2 (roadmap phase 5). There is **no "delete for everyone"**. Messages leave the server only by expiry.

- Deleting removes the message from the local cache and records a *tombstone* (its blob ids). Tombstones survive "clear cache" and "re-sync", so a re-sync can't bring the message back.
- A tombstone is dropped once the blob's server `expiresAt` has passed, because by then the blob can't return.
- Deleting only affects your device. Recipients keep their copies, and your self-copy stays on the server until it expires.
- Messages need a stable id for this. Today `DecryptedMessage` has no id; protocol v2 adds the `messageId` to it.

---

## 6. Server access control

| Decision | Status |
| --- | --- |
| "Only allowed keys can use the server". In reality, every request only *names* a key hash and never proves it owns that key. Anyone who knows a hash can list that user's blobs, POST unlimited blobs to them, subscribe to their "new message" pings, and join their calls (§7). | **Gap** |
| Unauthenticated blob DELETE. | **Fixed** (route removed; only the expiry worker deletes) |
| Unchecked Socket.io `join` / `leave` that let any socket enter any room. | **Fixed** (handlers removed; client never used them) |
| Plain HTTP between clients and server. Key hashes travel in query strings in the clear. | **Fixed in config** (`relay-server/deploy/Caddyfile`; API binds to loopback with `HOST=127.0.0.1`). Only protects a host that actually deploys it. |
| No rate limits or per-member quotas. | **Gap** |
| TURN username/password are static and compiled into every client. A public PWA makes them public. | **Fixed** (`GET /api/turn/credentials` issues HMAC credentials that expire after 12 h by default; `relay-server/deploy/turnserver.conf` uses `use-auth-secret`, refuses to relay to private addresses and writes no logs). Gated on a key hash until phase 3 moves it behind a token. |

### Decided: anonymous membership tokens (RFC 9474)

**What it provides:** cryptographic unlinkability between *who you are* (login) and *what you do* (every other request). Without it, every request carries your account id, so a perfect activity log exists by default, including by accident in proxy logs, error logs and crash dumps. With it, requests carry one-time tokens that even the server's own records can't connect to an account.

**How (RSA blind signatures):**

1. **Login (identified):** challenge-response. The server sends a nonce, and the client signs it with its ECDSA P-256 signing key. This is the only identified request.
2. **Blind:** the client invents random token values `m`, and for each picks a random blinding factor `r` and sends `H(m) · rᵉ mod n`. That number is uniformly random to the server; it reveals nothing about `m`.
3. **Sign:** the server signs the blinded values with its private key and returns them, counting them against the member's daily quota.
4. **Unblind:** the client divides out `r` and is left with a valid signature on `H(m)`: a token the server has never seen.
5. **Spend:** posting blobs, fetching blobs and getting TURN credentials each present one `(m, signature)`. The server checks the signature and that `m` hasn't been spent before. It can tell a member sent this, but even with full logs of issuance it can't tell which member: blinding makes every issuance session equally likely.

**Requirements:**

- **One issuer key for everyone.** If the server signed each member with a different key, the key would tag the tokens. Clients include the current issuer-key fingerprint inside their encrypted messages and warn on a mismatch. This is the one cross-check that stays: without it, a malicious *server* (not the admin) could quietly tag tokens per member and RFC 9474 would protect nothing.
- **Issuer key rotation: daily, and immediately when a member is removed.** The server can't revoke one member's tokens, because it doesn't know which tokens are theirs, so rotating the key is the only way to kill a removed member's leftovers. Everyone's unspent tokens die with it, and clients quietly fetch new ones.
- **Not on additions.** A new member has no old tokens to kill. Every rotation briefly shrinks the crowd: right after it, only the few members who have already refilled hold valid tokens. So extra rotations cost privacy and buy nothing.
- **Clients police rotations.** They accept a new key only on the daily schedule, or when it comes with a removal entry signed by an admin. Otherwise a malicious server could rotate keys constantly to split members into small, identifiable groups.
- **Refills:**
  - Each device keeps a **pool** of unspent tokens (e.g. 100). One token pays for one request, not one blob; a sync with a cursor is a single request.
  - When the pool drops below a threshold (e.g. 40) while the app is open, the app schedules a refill at a random moment in the next few minutes. A refill is one identified request (a login session) asking for a batch of blinded signatures, counted against a daily per-member quota.
  - iOS web apps don't run in the background, so refills only happen while the app is open. Topping up early, before the pool runs low, keeps "refill, then immediately use" from being the normal pattern.
  - **Receiving costs nothing.** Pushes are sent by the server and paid for by the *sender* (one token covers posting a message and its mention pushes). The service worker shows the notification from the encrypted push payload alone, with no network request, so being pinged all night spends none of your tokens. With the app closed nothing runs, so nothing is spent.
  - **Opening the app** costs one token for the sync. If the backlog spans several pages, the first token opens a short anonymous sync session (e.g. 60 s) that covers every page, rather than costing one token per page.
  - **Daily rotation keeps yesterday's key valid for 24 more hours**, so an overnight rotation doesn't empty pools and force a refill right on app open.
  - **Removal rotation has no overlap** (that's its purpose): every pool empties at once. The next app open must refill before syncing, which briefly links the identified refill to the anonymous requests that follow. This is accepted, because removals are rare. Refills after a rotation still happen after a random delay where possible.
- Web Crypto has no blind-RSA primitive: use a reviewed BigInt library or a careful implementation checked against the RFC's test vectors.

**Limits (honest):** it removes the account id from requests, but not the IP address. Against an operator who logs IPs:

- With **IP hiding** (VPN or Tor-style relay), tokens make requests genuinely anonymous. This is the only way sealed sender and anonymous fetching hold up against a logging operator.
- **Without IP hiding**, the operator falls back to IP and timing correlation. That's strong for a member on stable home Wi-Fi, but noisy on mobile networks, where IPs change often and many users share one (carrier NAT). It raises the bar from "the account id is in every request" to statistical guessing.

IP hiding is optional per member; members who want the strong guarantee should use it. Push registration is still identified (A, §9).

---

## 7. Calls

| Decision | Status |
| --- | --- |
| WebRTC mesh, Socket.io signaling, STUN plus optional TURN. Media is DTLS-SRTP peer-to-peer. | Current |
| The room id is a SHA-256 of the sorted member key hashes, so it's deterministic. | Current |
| SDP (including DTLS fingerprints) passes through the server **unauthenticated**, so the server or anyone on the plain-HTTP path can man-in-the-middle a call. The README's "E2EE voice/video" isn't true yet. | **Gap** |
| `join_room` accepts a client-*asserted* key hash, and the first joiner sets the room's allowed list. Clients automatically send an offer (with mic/camera) to any peer that appears. So anyone who knows the hashes can join and receive media, or squat a room id to block a call. | **Gap** |

### Decided: call tiles for everyone in the conversation

- During a group call, every conversation member gets a tile. Members not in the call show as a dimmed "not in call" rectangle with a **Notify** button that sends them a ring push (§9).
- It says "not in call", not "offline". The app only knows who has joined the room. Real online/offline presence would need the server to track who is connected, which is the kind of metadata Relay avoids.
- Starting or joining a call never notifies anyone by itself. Only **Notify** sends a ring. Rings are rate-limited per person (e.g. one per 30 s), and the receiver can mute rings per conversation.

Recommended fix: authenticate signaling end to end. Seal each offer/answer/ICE message with the pairwise key (the same ECDH as messages) so the server routes only opaque envelopes, and attach media only to a verified peer. Rooms use random ids shared inside encrypted messages instead of deterministic ones.

---

## 8. Clients

| Decision | Status |
| --- | --- |
| A message's sender was taken from the decrypted JSON (`senderKeyHash`) without checking it against the key that encrypted it. Any member (or anyone holding a member's public key) could impersonate any contact. | **Fixed** (`assembleVerifiedMessages` in `relay-web/src/lib/blobChunk.ts`, tests in `senderVerification.test.ts`) |
| Web: `identity.bin` (with the private key) is served from `public/identity/`, and `PUT /api/identity` overwrote it. `next dev` listened on all interfaces, so anyone on the LAN could download or replace your identity. | **Fixed** (dev/start bind to 127.0.0.1; PUT rejects non-local Host/Origin). **Decided:** move the identity into IndexedDB as non-extractable keys and remove `public/identity/` and `/api/identity`; this also closes the DNS-rebinding gap. |
| iOS app: received filenames were used as cache paths unsanitized, so `../identity.bin` could overwrite the identity file. | **Fixed** (`safeFilename` in `page.tsx`); goes away with the Capacitor app |
| iOS app: `identity.bin` is exposed in the Files app and in backups. | **Superseded**: the Keychain plan is dropped along with the Capacitor app. In the PWA, the key lives in IndexedDB. |
| Images are re-encoded through a canvas to strip EXIF/GPS before sending. | Current |
| Only messages from known contacts (or yourself) are shown. Contact cards received in chat are displayed, never auto-added. | Current |

### Decided: @mentions

- **Composing:** typing `@` opens a picker of the conversation's members, labeled with *your* names for them (display names are local to each user). The message stores the mentioned **key hashes** in a `mentions` field inside the encrypted content, never names.
- **Rendering:** each viewer shows a mention using their own name for that person. Mentions of you are highlighted, the message gets a highlight bar, and the conversation shows a mention badge until you read it.
- **Notifications:** the sender's client asks the server to push each mentioned member (§9). Mentioning someone who isn't your contact sends nothing.
- **`@everyone`** mentions every member of the conversation and notifies each of them.
- **Rate limits are per recipient**, enforced by the server (it knows push targets under A, §9): each member gets at most a few mention pushes per minute in total, and at most one `@everyone` push per minute, whoever sends them. Extra mentions aren't lost; they show up, highlighted, the next time the app opens.
- Mentions are the *only* thing that notifies, in groups and DMs alike (§9).

---

## 9. Distribution, customization and notifications

### Distribution routes

| Route | Paid Apple account? | Verdict |
| --- | --- | --- |
| App Store / TestFlight | Yes | Excluded |
| Firebase App Distribution | **Yes.** iOS builds must be ad hoc–signed with each tester's UDID in the provisioning profile, which needs the paid Developer Program. | Not viable |
| EU alternative marketplaces | Yes (plus Apple notarization) | Not viable |
| Sideload (SideStore, free Apple ID) | No | **Current → Decided: remove** |
| **PWA (Add to Home Screen)** | No | **Decided**: the only mobile route |

### How a Home Screen web app compares to a native app (iOS 16.4+)

| Works like an app | Differs from an app |
| --- | --- |
| Own icon, opens full-screen without browser bars, appears in the app switcher | Installed from Safari's Share → **Add to Home Screen** (other iOS browsers can too), not an app store |
| Its own storage, separate from Safari's, and exempt from Safari's 7-day storage cleanup | Deleting the icon deletes its data, including the identity; with no backups (§4) that means re-enrolling |
| Push notifications and the badge count | No background execution: calls will likely drop or mute when you leave the app or lock the phone (test this), and incoming calls can only arrive as a notification, never a ringing call screen |
| Camera, mic and WebRTC calls while open | Can't receive "Open with…" from AirDrop or Files (not needed: keys are generated in-app) |
| Works offline (service worker) | Updates apply on next launch with no review step, so whoever hosts the build can change it at any time |

### Decided: two ways to customize

**1. Plugins in the official PWA**
- A protected core owns keys, crypto, the wire format, the server connection and the plugin host.
- Plugins (installed from a URL or file, pinned by hash, stored in IndexedDB) can:
  - Change themes and CSS.
  - Replace UI components and add screens.
  - Render messages differently.
  - Add message types. These go inside the encrypted content, namespaced like `x-<plugin>/<type>`, and carry fallback text for people without the plugin.
  - Hook in before encryption and after decryption.
- Plugins run in sandboxed iframes with an opaque origin and talk to the core over `postMessage` through a narrow, versioned API. They can't read keys, the cache or the network, and can only ask the core to send. CSP enforces this.
- **Safe mode** starts the app with all plugins off, so a bad plugin can't brick it.
- The wire format can't be changed by plugins. Wire changes are versioned core releases.

**2. Fork and deploy**
- `relay-web` doubles as a template that users fork and deploy to their own HTTPS origin (e.g. GitHub Pages or Cloudflare Pages via a provided workflow). Anything can change, including the core.
- A protocol compatibility suite (golden test vectors) runs in the fork's CI and warns before a change breaks messaging with everyone else.
- Each origin has its own storage and push subscription, so a fork is added as a linked device (§4).

### Decided: direct push (A), only for @mentions and manual call rings

Safari requires **every** web push to show a visible notification, and it revokes a subscription after a few pushes that don't. So pushing every member for every blob would notify everyone of everyone's messages. Instead, pushes are rare and sender-triggered:

1. **Registration:** after login, each device registers its push endpoint against its member id.
2. **Triggers:** a push is sent **only** when
   - a message **@mentions** you (including `@everyone`), or
   - someone presses **Notify** on your tile in a call (§7).

   The sender's request tells the server which kind it is, so per-recipient limits apply (§8). Nothing else notifies: not DMs, not ordinary group messages, and not calls starting. Everything else appears the next time you open the app.
3. **Payload:** a small Relay-encrypted blob (pairwise key), wrapped in Web Push encryption to the device. The server forwards opaque bytes. The service worker decrypts it with the identity in IndexedDB and shows, e.g., "Alex mentioned you in Trip" using *your* name for the sender.
4. **No push logs:** the server sends the push and keeps no record of who was notified or when.

**Why A rather than a pseudonymous token (B):** B only hides the member behind a token. An operator who logs IPs links that token to the member anyway, because registration and login come from the same IP. Against a database leak, A without push logs exposes about as little (a member → push address mapping). B's extra complexity would add a false sense of security, so it's dropped.

**What the server learns, live:** who is being mentioned or rung at that moment, and (from IPs) roughly who sent it. Apple's push service sees each wake-up, not the payload. Nothing is stored.

**Reference, rotation (D), not planned.** What links wake-ups together is the *push endpoint*, not the token. Every token maps to the same endpoint, so changing tokens alone hides nothing from the server. Real rotation means re-subscribing for a new endpoint and registering it anonymously.

| Policy | Unlinkability | Cost |
| --- | --- | --- |
| Per epoch (**daily, with random jitter**) plus on each app open | The server can link the wake-ups within one day | One re-subscribe a day; low risk |
| Per notification | Each endpoint is used once, so wake-ups can't be linked by endpoint | Only helps if re-registration can't be linked by **IP address or timing**. A device that re-registers from the same IP right after a push is trivially linked. It also means a re-subscribe inside the push handler (unverified on iOS; it may need a user gesture), more chances of missed notifications, and churn against Safari's known subscription bugs. |

**All targeted-push approaches.** iOS web push always goes through Apple's push service, which sees each wake-up (not the payload); none of these avoid that. They differ in what the **relay server** learns:

| # | Approach | Server learns | Notes |
| --- | --- | --- | --- |
| A | Server maps member → push endpoint; sender names the recipient | Exactly who each message is for | What normal apps do. Undoes recipient-blindness. |
| B | Endpoint registered under one static random token, shared with contacts | A stable pseudonym and its wake history | No names, but all of one person's wake-ups are linked. |
| C | Tokens rotate per epoch (`HMAC(pairwise key, epoch)`), endpoint stays the same | Same as B | Every token maps to the same endpoint, so the server links them anyway. Only useful combined with D. |
| D | Endpoint rotates too (re-subscribe), registered with anonymous tokens (§6) | Unlinked wake-ups within each rotation window | **Current decision** (daily + on app open). Weakened by IP address and timing. |
| E | **Decouple the wake from the blob:** post the blob, then send a separate wake request after a random delay (e.g. 0–30 s), with a different anonymous token. With fetch-all, the wake needn't reference the blob at all. | Some endpoint was woken, with no stated link to any blob | Breaks the direct blob→device link; only timing remains, which is weak when traffic is low. Costs notification delay. Stacks on D. |
| F | **Batching:** the server sends pushes only on a fixed tick (e.g. every 15 s) | Same as E, coarser | Blurs timing for everyone; adds up to one tick of delay. Stacks on D/E. |
| G | **Separate push proxy:** a second, independently run server holds endpoints and sends pushes; the relay never sees endpoints | Relay: nothing about devices. Proxy: wake-ups, but no blobs | Only helps if the two operators don't collide. Senders can't call Apple's push service straight from the browser (CORS, likely; unverified), so a proxy is needed for any "sender pushes directly" design. |
| H | **Cover pushes** (fake wake-ups to hide real ones) | — | **Not possible on iOS:** every push must show a visible notification. |

Chosen: **A**, limited to mentions and manual call rings, with no push logs (above). B–F only help against an operator who logs, and IP correlation defeats them without IP hiding; G only if a second, trusted operator exists.

**Alternatives considered** (all compatible with recipient-blind storage, but worse notifications):

- **Generic throttled push:** the server pushes every member at most once every N minutes ("New activity in Relay"); the service worker syncs and updates the badge. It reveals nothing about recipients, but it's vague, and people get pinged for messages that weren't for them.
- **Digest at fixed times:** like the above, but on a schedule (e.g. every 30 min, only if anything is new). Fewer pings, more delay.
- **Hybrid:** targeted push for members who opt in; everyone else gets the generic push or none.
- **No push:** notify only while the app is open.

Real per-message notifications with a fully hidden recipient aren't possible on iOS, since every push must show a notification. iOS web apps can't do periodic background sync either.

Rotation (D) and per-notification rotation are **not planned**. If wanted later, they need IP hiding that doesn't rely on iCloud (e.g. a VPN or Tor-style relay) to be worth it.

---

## 10. Repo conventions

- No agent instruction files (`AGENTS.md`, `CLAUDE.md`, `.cursorrules`, etc.) exist yet. Point any you add at this file.
- `relay-web/README.md` lists the files user customizations must not touch (crypto, identity, blob protocol). With plugins and forks this becomes the "core" boundary.
- Both `relay-web` and `relay-server` have a `package-lock.json`. Next.js is pinned to ≥ 15.5.7 because of the React Server Components RCE (CVE-2025-66478 / CVE-2025-55182).

---

## 11. Roadmap

Ordered by dependency. Each phase should land as its own reviewed change.

| # | Phase | Main work | Needs |
| --- | --- | --- | --- |
| 0 | Land current fixes | **Done**: security fixes, `tsc`/`next build` clean, lockfiles for web and server | — |
| 1 | TLS and TURN | **Done in code and config**: Caddy and coturn configs in `relay-server/deploy/`, short-lived TURN credentials endpoint, client fetches ICE servers per call. The host still has to set up the domain and deploy. | — |
| 2 | Self-generated identities | Client keygen + identity format v5 (adds an ECDSA signing key, drops `myUserNumber`); server `Member` table with public keys replacing `AllowedKey` hashes; admin keys in server config; signed QR codes with 3-minute expiry; admin-signed member directory with version check; key-change notices; retire `generate-20-identities.mjs`; hard cutover (wipe server, re-enroll everyone) | 0 |
| 3 | Login, tokens and admin | Challenge-response login; RFC 9474 blind-token issuance, daily issuer-key rotation, key-consistency check, spent-token store; per-member token quotas; move the TURN credentials endpoint behind a token; no request/IP logging; Settings → Admin tab (enroll, remove + signed revocation list, server status) | 1, 2 |
| 4 | Key storage | Identity in IndexedDB as non-extractable keys; in-app key generation; remove `public/identity/`, `/api/identity` and `.bin` export | 2 |
| 5 | Protocol v2 | Sealed sender + recipient-blind blobs; `GET /blobs?since=` cursor; attachments as separate blobs; stable `messageId`; `mentions` field + mention picker, `@everyone`, highlight and badge; encrypted local cache + Settings → Storage tab; delete for me; linked devices (QR link, self-message sync, device list) | 3, 4 |
| 6 | Call security | Seal offer/answer/ICE with pairwise keys; random room ids; attach media only to verified peers; tiles for members not in the call | 3 |
| 7 | Official PWA | Static export; manifest, icons, service worker; `storage.persist()`; strict CSP; deploy pipeline publishing commit + build hash; push registration (A, per device, no push logs, per-recipient rate limits) + service worker that decrypts and shows mention/ring notifications; call-tile **Notify** button with rate limit; install guide | 1, 3, 4 (5–6 before wide use) |
| 8 | Plugins | Core/plugin boundary; sandboxed iframe host + versioned `postMessage` API; install from URL/file with hash pinning; plugin message types with fallback text; safe mode | 7 |
| 9 | Fork and deploy | Template + deploy workflow (Pages); protocol golden test vectors in CI; fork guide | 5, 7 |
| 10 | Remove Capacitor app | Delete `relay-mobile/`, its README section and `@capacitor/*` deps in `relay-web`; cutover note for current users | 7 |
| 11 | Docs and tests | README rewritten for the new setup; tests for login/tokens, protocol v2, signaling and the plugin API; keep this file current | each phase |
