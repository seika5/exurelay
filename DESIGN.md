# Exurelay design and security decisions

This is the single place for *why* Exurelay works the way it does: the threat model, the deliberate trade-offs, the decisions made but not built yet, and known gaps. Setup steps live in [README.md](README.md). When you change behavior described here, update this file in the same change.

Each decision has a status:

- **Current**: how the code works today, intended.
- **Decided**: agreed direction, not implemented yet.
- **Open**: needs a decision.
- **Gap**: current behavior that contradicts the goals below; fix it.

---

## 1. Goals and threat model

Exurelay is messaging and calls for a closed, invite-only group. It started with a fixed set of 20 accounts and now has any number of enrolled members (§4).

| Party | What they should learn | What they should be able to do |
| --- | --- | --- |
| Exurelay server / host | Ideally nothing beyond "some member is online" and blob counts/sizes | Store and forward opaque data; keep non-members out |
| Network observer | Nothing beyond "this IP talks to the relay" | Nothing |
| Outsider who knows a key hash | Nothing | Nothing |
| Another member | Only what was sent to them | Message/call any member; see only their own conversations |
| Whoever hosts a web app build (official or fork) | Same as server, but **they serve the code**, so they are fully trusted by that build's users | n/a |

Out of scope: a compromised device, a malicious build or plugin the user chose to install, traffic analysis by a global observer.

### Two levels of server adversary

Every request reaches the server from an IP address. A typical member's IP is stable and shared across all their requests, including the identified ones (login, admin). So an operator who **logs IPs and timing** can tie "anonymous" requests back to a member. Exurelay therefore promises different things against two kinds of server:

| Server adversary | Example | What Exurelay protects |
| --- | --- | --- |
| **Data at rest** | Database dump, seized disk, a curious admin browsing tables | Content, senders, recipients, who was notified (§5, §9). It does see the member list: public keys, devices, who is an admin (below). |
| **Actively malicious operator** | Logs IPs and timing for every request | Content only. Senders, recipients, notification targets and online times can be inferred from IPs and timing unless members hide their IP (VPN/Tor-style relay). |

Any measure that only hides something from the second kind of adversary *without* IP hiding gives a false sense of security, so it's marked as such or not built. The server code must not log IPs or request details, and the operator must keep it that way.

### What the server stores in plain text

Everything else in its database is encrypted, signed public data, or deleted on expiry. Not logged at all: request details and IPs (no request logger, Caddy without `log`, coturn logs to `/dev/null`), and blob deletions (a per-minute count would record message volume over time).

| Stored in plain text | Why | Status |
| --- | --- | --- |
| Members' and devices' public keys and key hashes, enrollment dates, who is an admin, who left | The member list and its signatures: every app checks it, so the server has to serve it | Needed |
| Push subscription endpoints, tied to a device and member | The server sends the push; the payload itself is encrypted (§9) | Needed for notifications |
| Which member wrote a sealed name copy for which device, and when it last changed (`ProfileCopy`) | Each device fetches only the copies for it. Every member writes one for every device, so the pairs say nothing beyond the member list | Needed |

Names are sealed: display names to every member's devices, device names to the member's own devices only ("Names" in §4). Before this, both were in plain text, and readable by anyone who knew the server's address (`GET /api/directory` needs no login). Admin labels, which paired each member's key with a name the admin chose, were removed. `install.sh` drops the old `Profile` and `AdminLabel` tables on upgrade; devices linked before then still have their name in their (signed, public) certificate until they're unlinked and linked again.

---

## 2. Components

| Component | Role | Trust |
| --- | --- | --- |
| `relay-server/` | Express + Socket.io + Postgres. Stores fixed-size encrypted blobs, relays WebRTC signaling, runs the expiry worker. | Untrusted for content, trusted for availability |
| `relay-web/` | Next.js client. All crypto happens here. Can run locally, as the official PWA, or as a user's own deployed fork. | Trusted (by whoever runs that build) |
| Official PWA | **Decided.** The owner-hosted build of `relay-web`. Its core can't be changed by users; plugins can extend it (§9). | Trusted by whoever installs it |
| Forked builds | **Decided.** Users fork `relay-web` and deploy it to their own HTTPS origin for full control (§9). | Trusted by their owner |
| `relay-mobile/` | Capacitor iOS wrapper, sideloaded via SideStore. | **Removed** (phase 10): replaced by the installed PWA, plugins and forks |

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

- **No forward secrecy.** Static-static ECDH means anyone who gets a member's private key can decrypt every blob still on the server (up to ~4 days) and any ciphertext recorded earlier. A ratchet (e.g. Double Ratchet) would fix this; it's a large change. **Open.**
- **Not post-quantum.** Ciphertext harvested now could be decrypted by a future quantum computer. Hybrid ML-KEM isn't in Web Crypto on all target browsers yet. **Open, low priority.**
- **Volume leaks.** Blob count reveals rough size (1 blob ≈ text, many ≈ file), and POST timing reveals activity.
- A legacy v0 packet format (no AAD, no per-message key) is still accepted on read. It goes away at the hard cutover (§4).

---

## 4. Identity and enrollment

| Decision | Status |
| --- | --- |
| The host ran `generate-20-identities.mjs`, so **the host held every private key** and could decrypt everything. | **Replaced** (phase 2; script deleted) |
| Each user generates their own keypair on their own device. Only the public keys are shared, in person, via a signed enrollment code. | **Done** (phase 2) |
| Move off the fixed 20 accounts to any number of enrolled members. The identity file's `myUserNumber` (1–20) goes away. | **Done** (phase 2) |
| The identity (your ECDH keypair, your ECDSA signing keypair, your display name, per-contact local settings), one per server, is either a passphrase-encrypted `.relayid` file in a folder you pick (desktop Chrome/Edge) or a record in the app's IndexedDB with non-extractable keys (everywhere else); see "where keys live" below. The old unencrypted `.bin` format (last v6), `public/identity/`, `/api/identity` and **Save identity file** are gone. In app-storage mode the app asks the browser to keep its storage (`navigator.storage.persist()`). | **Done** (phase 4) |
| Group names aren't in the file. They come from `group_rename` messages, so today they disappear when those blobs expire. | Current → kept in the local cache (§5) |
| Contacts are exchanged in person to prevent MITM, one pair at a time (n² meetings for n people). | **Replaced** with the admin-signed directory (below; phase 2) |
| Who enrolls and removes members: the **host (admin)**, from an admin tab in Settings. | **Decided** (below) |

### Decided: where keys live

Keys are generated in the app. Exurelay doesn't use iCloud or any other cloud service for them. Where they're kept depends on what the browser can do (`relay-web/src/lib/keystore.ts`):

- **Desktop Chrome/Edge: an encrypted file in a folder you pick.** At setup, a popup explains the risks, asks for a folder and a passphrase (at least 10 characters) and needs an "I understand there's no recovery" tick. The identity is written to `relay-<server host>.relayid` in that folder (`relay-web/src/lib/identityFile.ts`):
  - PBKDF2-SHA256 (600,000 iterations) over the passphrase, split by HKDF into two AES-256-GCM keys. One encrypts the keys section, written once at creation; the other encrypts the settings section (name, nicknames, volumes), rewritten on each change. Both are authenticated together with the header.
  - The private keys are readable only while the file is created and while it's unlocked; after that they're held as non-extractable keys. The app keeps only the settings key in memory, which can't decrypt the keys section.
  - Each launch shows an unlock screen asking for the passphrase. The browser remembers which folder (a directory handle in IndexedDB) and may ask to allow access again; it never holds the keys at rest. If that's lost (site data cleared, folder moved), "Choose its folder" finds the file again, and on a new computer "I already have an identity file" does the same.
  - The user can copy the file as a backup. Anyone with the file *and* the passphrase is that member, so the popup warns against cloud-synced folders (iCloud Desktop & Documents, Dropbox, OneDrive, Google Drive), shared folders and git repositories.
  - Not built yet: changing the passphrase, or moving the file from Settings.
- **Everywhere else (phones, Firefox, Safari): the app's own storage.** IndexedDB, as non-extractable `CryptoKey`s. No export and no backup; a setup popup says so. Phones should create the identity in the installed app, not a browser tab (separate storage).
- **Losing the identity** (lost file or passphrase; new phone, deleted Home Screen icon or cleared site data in app-storage mode) means the account is gone: the admin removes the old member, enrolls a new key, and contacts are re-exchanged in person. Messages from the last ~4 days can't be recovered, because they were encrypted to the old key. Linked devices (below) make this rarer.
- **No migration:** the old `.bin` format, the fixed-20 identities and blob format v0/v1 are deprecated entirely. The new version is a hard cutover: the server is wiped, and everyone generates new keys and is enrolled again.

### Decided: linked devices (one account, several devices)

Keys aren't copied between devices (they're non-extractable once loaded, §4 "where keys live"), so **each device has its own keys**, listed under one member. Decided in phase 4; built in phase 5 with protocol v2.

1. **Link:** on the new device, choose "Link to existing account". It makes its own keys and shows a QR with its public keys, valid for 3 minutes.
2. **Approve:** on an existing device, scan it and compare the short code on both screens. The existing device signs a device certificate for the new keys (no device name: that goes sealed, "Names" below) and publishes it. No admin is needed: the member's devices vouch for each other, and clients only accept certificates signed by one of that member's devices in the admin-signed directory.
3. **Sending:** a message is encrypted once per device of each recipient (and to your own other devices for sync), so it costs more upload with more devices. Receiving is unchanged.
4. **Staying in sync:** contact, name and setting changes go to your other devices as encrypted self-messages. Each device keeps its own cache; self-copies of sent messages appear everywhere. A new device doesn't get old messages unless you copy them to it ("History to a new device", §5).
5. **Push:** each device registers its own push endpoint, and a mention notifies all of them.
6. **Device list:** Settings shows your devices by name. Any of your devices can unlink another (a signed revocation); unlinking the one you're on wipes its data.
7. **Lost or stolen device:** unlink it from another device. Only that device's key is exposed, and nobody else has to re-verify you. With no other device left, the admin re-enrolls you as before.

**As built (phase 5d):**

- **Member vs device:** a member is their enrolled key in the admin-signed directory. Each other device has its own keys and a certificate `{ type: "relay-device", member, ecdh, sig, name, addedAt, signer }` signed by one of the member's devices (the enrolled key, or an already-certified device). Unlinking is a signed `relay-device-revoke` from any of their devices, that one included. The server stores both (`Device`, `DeviceRevocation`), refuses certificates for keys already in use or unlinked, and drops a member's devices when they're removed or leave. Clients verify every chain themselves (`verifyDevices` in `relay-web/src/lib/signed.ts`).
- **Linking:** the new device joins the server and creates an identity as usual; its waiting screen shows its enrollment code. On an existing device, Settings → **Devices** → scan or paste it, check the fingerprint, name it, **Link device**. No admin is involved. The waiting screen re-checks every 5 s, so it opens moments later.
- **Messages:** every send has a slot for every device of every recipient and of the sender (the self-copy). The slot proves which device sent it; the message must name that device's member. Names, nicknames and volumes sync to your other devices as `device_sync` messages, which are never shown or cached. Newer `settingsAt` wins, and a newly linked device gets them at once.
- **Logins and calls:** a device logs in with its own key; its session records its member, so removing a member ends all their devices' sessions. In calls the server reports each peer's member and device; signals are sealed device to device and allowed by member.
- **Names and leaving:** any device may sign the member's display name or their leave.
- **Unlinks are permanent:** an unlink has no trusted order relative to certificates, so if re-linking the same keys were allowed, the server could replay an old certificate to revive a lost or stolen device. So the server refuses certificates for unlinked keys, and clients drop a revoked key whatever its certificate. An unlinked device sees "This device was unlinked" and **Start over** (new keys, same server), then can be linked again.
- **Admin device:** admin rights belong to a device: the member list's `admins` may hold a member's enrolled key or one of their linked devices' keys (the server and clients accept either, if that device belongs to a member still on the list). An admin moves admin to another of their devices in Settings → Devices → **Make admin device**, which signs a member list swapping this device's key for that one's. An admin device can't be unlinked while it holds admin (the server and the app both refuse: its key could still sign member lists), so move it first. Removing a member drops admin held by any of their devices. Members admin shows a member as admin if any of their devices is.
- **Limits:** the enrolled device can't be unlinked: it *is* the member (its key is in the signed member list, and every other device's certificate chains to it). Replacing it is re-enrollment by the admin, which shows contacts a key-change notice and drops the old key's devices. A new device doesn't get old messages.

### As built: names (sealed profiles)

- **What's sealed:** a member's display name, for every current device of every member (their own other devices included), and the names of their devices, for their own devices only. Certificates and the member list carry no names.
- **How:** the sending device derives a key with HKDF over the static ECDH secret with the recipient device (as messages do), with info `exurelay-profile-v1:` + a random 16-byte nonce, so it can't collide with a message key (whose info is a bare 16-byte id). AES-GCM, with author, sender device, recipient device and `updatedAt` as associated data, so the server can't move a copy to another member or device or change its date. The plaintext is padded (512 bytes for a name, 2 KB steps with device names), so lengths don't reveal names. `relay-web/src/lib/profileSeal.ts`.
- **Storage:** one `ProfileCopy` per (member, recipient device), newest `updatedAt` kept. Writing and reading need a login: a device writes copies as its own member, for other current devices, and reads only the copies addressed to it. Removing a member or unlinking a device deletes the copies by and for them.
- **Sending:** each device sends only what changed for each recipient, after a rename, a new member or device, or a device-name change. `updatedAt` follows the settings already synced between a member's devices, so a device that hasn't caught up can't overwrite a newer name. The server announces changes on the socket, and apps refresh at once.
- **Trade-off:** a new member or device sees someone's name once one of that person's devices has been online since. Until then it shows their key fingerprint. The server can still withhold a copy or replay an older one, but can't read or forge one.

### Decided: admin tab

- The server config lists the admin public key(s); the host is the first admin. The Settings → **Admin** tab appears only when the server confirms, at login, that this identity is an admin. Admin actions use identified, signed requests.
- **Members:** list members by display name and key fingerprint, plus enrolled date. There is no last-seen field: the server doesn't track it.
- **Enroll:** scan the newcomer's QR or paste their public-key code, in person, and check the fingerprint.
- **Leave:** a member can leave on their own. The app signs `{ type: "relay-leave", keyHash, server, ts }` (fresh within 5 minutes, for this server only) and posts it to `POST /api/directory/leave`. The server checks the signature, then deletes them as a member and their name, and ends their sessions and sockets. (Messages already sent to them stay until they expire: since protocol v2 the server can't tell whose they are.) It keeps the signed leave as a `Departure` until an admin's next directory drops them, and it won't re-add them from a directory that still lists them. Clients check each departure against the member's own key (so the server can't make someone vanish), hide that member right away, and an admin's app publishes the directory without them automatically. The leaving device deletes that server's identity, tokens and rollback state; coming back means a new identity, join code and approval. The last admin can't leave. If the server can't be reached, the app offers to leave on the device only, and the member stays listed until an admin removes them. Leaving doesn't rotate the issuer key: the member deleted their own tokens. Privacy cost: until the admin's list catches up, the server's database shows that this member left by choice rather than being removed (an admin removal looks the same to it otherwise). A blinder version would send the leave to the admins as an encrypted message; it wasn't worth the delay, since the server sees the list change moments later anyway.
- **Remove/revoke:** delete the member so they can no longer log in. Anonymous tokens must expire quickly (issuer key rotated e.g. daily) so a removed member's leftover tokens stop working. The server publishes a signed list of removed keys, and clients grey out those contacts.
- **Server status:** blob count, storage used, token quotas, TURN status. No per-member activity.
- Adding more admins is possible; admins can't read anyone's messages.

### Decided: admin-signed member directory

Pairwise QR exchange needs a meeting for every pair. Instead, the in-person step happens once per member, with the admin at enrollment, and the admin vouches for everyone:

1. **Directory:** the server publishes the member list (public keys), signed by an admin key; each member's display name travels sealed ("Names" below). Clients verify both signatures, so the server alone can't insert or swap a key.
2. **Contacts:** every directory member is a contact. **Anyone can message anyone** in the directory; messages from keys that aren't in it are dropped.
3. **No rollback:** the signed directory carries an increasing version number, and clients refuse a version older than the newest they've seen. That stops a hacked server from replaying an old directory (e.g. one from before a removal). It's cheap, so it stays.
4. **Key changes** (re-enrollment after a lost device) show a notice in conversations with that person.
5. **Removals** come from the same signed directory, so removed members are greyed out (§4 admin tab) and their key-rotation entry is verifiable (§6).

**Trust:** the admin is fully trusted. A compromised admin, or a compromised member device, is game over for whatever it can reach, and no extra verification tiers or cross-checks are built for that. The admin key lives on the admin's device, not on the server, so **hacking the server alone** still can't add or swap keys.

Enrollment: the new user's app generates keys and shows a QR/short code containing its public key, a timestamp, and a signature over both. The admin scans it in person, and the server adds the key to the member list. **All QR codes** (enrollment, device linking) **expire after 3 minutes**: a photographed or leaked code can't be replayed later, and the signature proves the presenter holds the key. The server stores **public keys** (not just hashes) so it can verify logins (§6).

### As built (phase 2)

- **Signed records** travel as `{ body, signature }`, where `body` is the exact JSON string that was signed (ECDSA P-256 / SHA-256, raw signature, base64). Verifiers never re-serialize, so client and server can't disagree about canonical form. Code: `relay-web/src/lib/signed.ts`, `relay-server/src/lib/signed.js` and `directory.js`.
- **Admin keys never come from the server.** In phase 2 they were built into the app (`NEXT_PUBLIC_ADMIN_SIGNING_KEYS`). Phase 3 replaced that with join codes that pin them per server (below), so one app build can serve any number of independently hosted servers.
- **Display names are separate profiles.** Renaming yourself doesn't need the admin. Originally each member signed `{ keyHash, name, updatedAt }` and the server served it to anyone; now the name is sealed to each device ("Names" below).
- **Publishing needs no login.** `POST /api/directory` is authorized by the admin signature itself, and the server also refuses a version that isn't newer. The server mirrors the newest directory into its `Member` table, which gates logins, and through them blobs, calls and TURN credentials.
- **Rollback protection:** each device stores the newest directory version it has accepted (`localStorage`) and refuses anything older.
- **Enrollment:** the newcomer's app shows a QR plus a copyable code with a key fingerprint, renewed every 3 minutes. The admin pastes the code in Settings → Members, checks the fingerprint against the newcomer's screen, and can mark the newcomer as replacing an existing member's lost key. Phase 3 added camera scanning (Settings → Admin).
- **Key changes and removals:** a re-enrolled member's conversation shows a notice naming the key they replaced. A removed member's conversation is greyed out, with no composer or Call button.

---

## 5. Message storage and metadata

| Decision | Status |
| --- | --- |
| Blobs are fixed 64 KB, stored ≤ ~96 h: expiry = UTC midnight of the send day + 72 h + random 0–24 h. Exact send time is never stored. | Current |
| Server backups (`relay-backup`, nightly, 14 kept) hold the member list, devices, sealed name copies, push subscriptions and `.env` secrets, never blobs, spent tokens or issuer keys, so no backup keeps a message past its expiry. Disk-level snapshots (Lightsail's automatic snapshots, EBS snapshots) would, so the docs say not to turn them on. | Current |
| A deleted blob's bytes stay in PostgreSQL's table file (and possibly its WAL) until the space is reused. The worker runs `VACUUM "Blob"` hourly so the space is reused sooner; nothing promises the bytes are gone from disk. That's acceptable only because blobs are end-to-end encrypted and carry no sender. | Current |
| No local message history; clients re-download and decrypt everything (including a self-addressed copy of their own messages). History ends when blobs expire. | **Current → Decided: replace** with an encrypted local cache (below) |
| Server addresses each blob by **recipient key hash**. | **Removed** (phase 5a, below) |
| The sender's public key was in **plaintext** in every blob header, so the server learned sender→recipient for every message. | **Fixed** (phase 5a: sealed sender, below) |

### Decided: sealed sender

The server stores a blob with nothing about who sent it. (Planned as an ECIES-style one-time key per send; built instead with slots keyed by the static sender–recipient secret plus a random nonce, so no blob carries a public key: see "As built (phase 5a)" below.)

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
2. ~~Store file attachments as separate blobs that only the real recipient fetches.~~ **Dropped:** that fetch pattern would show the server which blobs are attachments. Attachments travel like messages (phase 5a).
3. Notifications use targeted push (§9).
4. ~~Smaller buckets for text.~~ **Dropped:** one size for everything (admin-set, default 64 KB), so text and attachments look alike. Encrypting each send once instead of per recipient keeps bandwidth down instead.
5. **Open, for larger groups:** split blobs into K buckets by a rotating recipient tag. Each member then fetches only their bucket, which cuts bandwidth by K but shrinks the crowd a recipient hides in from N to about N/K.

Even without a recipient field, the server must still keep non-members out (§6).

### As built (phase 5a): protocol v2 wire format

Every send (message, file, call event, group rename) is encrypted **once** and spread over blobs of one fixed size **S**, each of which looks like random bytes. The server stores `seq` (a counter), the bytes and `expiresAt`: no sender, no recipient (`relay-web/src/lib/sealed.ts`).

- **S** is set by the admin in the signed member list (`blobSize`, 16–256 KB in 1 KB steps, default 64 KB). The server refuses blobs of any other size, so every blob on a server looks alike.
- **Body:** the JSON message, encrypted with AES-256-GCM under a random one-time message key.
- **Head blob** (the one that opens a send): 32 random bytes (a nonce), then one 104-byte slot per recipient in random order, then the start of the body. Slot = `tag (16 B) ‖ AES-GCM(kek, messageKey ‖ bodyLength ‖ bodyStart ‖ SHA-256(body))`, where `tag ‖ kek` = HKDF over the **static** ECDH secret between sender and recipient, salted with the nonce, with the sender and recipient key hashes in the info (the secret is the same both ways, so the info fixes the direction).
- **Finding your slot:** for each blob, a recipient computes the tag every member would have used for them (one small hash per member, from ECDH secrets computed once per member) and looks for it at the slot positions. Everyone else finds nothing.
- **Sender authentication (deniable):** only the sender and that recipient know their static secret, so the slot that matches proves who sent it, without a signature anyone else could check. The body hash in the slot stops another recipient (who also learns the message key) from swapping the body.
- **Continuation blobs:** `tag_j (16 B) ‖ next body bytes`, with `tag_j` derived from the message key, so only recipients can tell which blobs continue which send.
- **Self-copy:** one more slot, for your own key. No extra blobs.
- **Decoys:** each send adds a random 0–N blobs of pure random bytes, N set by the admin (`decoys` in the signed member list, default 3, max 16).
- **Nothing to tell apart:** heads, continuations and decoys contain no public key or fixed bytes, so they're indistinguishable. Upload order is random too: everything is shuffled, with the head somewhere in the first batch of 64 (recipients keep the last 128 unplaced blobs in memory, so a head can come after its continuations).
- **Late members:** if a new member's send arrives before your member list has them, the blob waits in that memory window and opens when the list refreshes.
- **Fetching:** every member downloads every blob once with `GET /api/blobs?since=<seq>` (binary pages), and the server pings all members' sockets after each upload. Uploads take turns (a Postgres advisory lock around each batch's insert), so blobs become visible in `seq` order and a cursor never skips a batch that committed late.
- **Attachments** travel the same way as messages, so they're indistinguishable from text and every member downloads them (a 5 MB photo costs every member 5 MB once). There's no size limit.
- **Limits:** a send can have at most ⌊(S − 32) / 104⌋ recipients including yourself (629 at 64 KB). Trial decryption costs one small hash per member per blob: nothing at tens of members, seconds when catching up days of traffic at many hundreds.
- **What the server still sees:** when uploads happen and how big each batch is, and (from IPs) roughly who uploads and downloads. Not who sent what to whom, or text vs. files.
- Hard cutover: older blobs aren't readable.

### Decided: encrypted local cache

With fetch-all, re-downloading the whole window on every launch would cost up to ~77 MB, so clients keep a local cache:

- **What's stored:** the sync cursor and decrypted messages (attachments travel inside them since phase 5a). The cursor means blobs already processed are never re-downloaded, so their ids needn't be kept.
- **At rest:** encrypted with a random AES-256-GCM cache key, kept as a non-extractable `CryptoKey` in IndexedDB. The cache data itself is also in IndexedDB.
- **Self-copies:** keep sending them, so a cleared cache can recover your own messages from the last ~4 days.
- **Settings → Storage tab:**
  - Show the size used, split into messages and attachments.
  - Retention: N days, **default 7**, counted from the blob's server `expiresAt` (which already includes the 72 h + 0–24 h jitter). A message is removed locally at `expiresAt + N days`, about 10–11 days after it was sent. Basing it on `expiresAt` rather than `sentAt` means local deletion times carry the same jitter and don't pin down the exact send time.
  - Clear attachments only, clear one conversation, or clear everything.
  - "Re-sync from server": wipe the cache and re-download what the server still has.
  - Logging out or removing the identity wipes the cache and its key.

### As built (phase 5b): encrypted local cache

- **What's kept** (`relay-web/src/lib/messageCache.ts`): every message that decrypted for you (yours included, from the self-copy) with its blob's `expiresAt`, and the sync cursor. Blobs that weren't for you aren't kept; the cursor means they're never downloaded again.
- **At rest:** each message is its own IndexedDB record, AES-256-GCM encrypted and bound to its identity and `messageId`; the cursor likewise. Nothing about a message is stored in the clear.
- **Cache key:** in folder mode it's derived from the passphrase at unlock (HKDF, alongside the identity file's other keys), so the cache can't be read without unlocking and the browser never holds a key for it. In app-storage mode it's a random non-extractable key in IndexedDB.
- **Resuming:** the server stores each upload batch in one insert, so a finished sync has seen every batch whole. The saved cursor is the last blob seen, held back only to just before a send still waiting for pieces from a later batch (a send over 64 blobs). A launch downloads only what's new. Duplicates are dropped by `messageId`. The memory window for late members isn't saved, so a message from a brand-new member that arrives just before you close the app opens only after a re-sync.
- **Retention:** a message goes at `expiresAt` + N days, N per server (default 7, 1–365), in Settings → Storage.
- **Settings → Storage tab** (everyone): counts and sizes of messages and files on this device, retention, **Remove files only** (the message stays, marked "removed from this device"), **Clear conversation**, **Clear everything** (messages still on the server don't come back), **Re-sync from server** (clear, then download whatever the server still holds).
- **Leaving a server or logging out** wipes that identity's cache, its cursor and (app mode) its cache key.

### As built: history to a new device

A newly linked device can't read older messages: each was sealed to the devices that existed when it was sent. **Settings → Devices → Copy my message history** sends the messages saved on that device to my other devices, as hidden `history` messages sealed to my devices only (like `device_sync`), in batches of at most 192 KB (`relay-web/src/lib/historyTransfer.ts`).

- **Kept as they were:** each message keeps its blob's `expiresAt`, so the receiving device deletes it on the same retention schedule as the sender. Messages past retention aren't sent; ones the receiver already has are skipped.
- **Small on purpose:** every member downloads every blob (recipient-blind storage), so a copy costs the whole group bandwidth. File contents stay behind (they show as "removed from this device"), and the copy stops at 2 MB, newest messages first; the app says how many were left out.
- **Trust:** a device accepts history only from another of the member's own devices (the sealed slot proves which device sent it). That device could put words in other members' mouths in its copy, but it's the member's own device, which they already trust with everything.
- **Only on request:** copying puts old messages on more devices, so it's a button, never automatic.

### Dropped: delete for me

Planned for phase 5, dropped before it was built. It could only remove a message from your own device: recipients keep their copies and the blob stays on the server until it expires (~3–4 days), so it does little and could be mistaken for "unsend". There's no "delete for everyone" either, for the same reason: recipients have already downloaded and decrypted it. Settings → Storage (phase 5b) still clears files, a conversation or everything from your device.

---

## 6. Server access control

| Decision | Status |
| --- | --- |
| "Only allowed keys can use the server". In reality, every request only *names* a key hash and never proves it owns that key. Anyone who knows a hash can list that user's blobs, POST unlimited blobs to them, subscribe to their "new message" pings, and join their calls (§7). | **Fixed** (phase 3): blob and TURN requests each spend an anonymous member token; the socket needs a login session and can only listen and join calls as its own key. Any member can still fetch another member's (encrypted) blobs by hash until protocol v2 drops recipient hashes. |
| Unauthenticated blob DELETE. | **Fixed** (route removed; only the expiry worker deletes) |
| Unchecked Socket.io `join` / `leave` that let any socket enter any room. | **Fixed** (handlers removed; client never used them) |
| Plain HTTP between clients and server. Key hashes travel in query strings in the clear. | **Fixed in config** (`relay-server/deploy/Caddyfile`; API binds to loopback with `HOST=127.0.0.1`). Only protects a host that actually deploys it. |
| No rate limits or per-member quotas. | **Partly fixed** (phase 3): token issuance is rate-limited per member (a burst of `TOKEN_BURST`, default 200, then `TOKEN_RATE_PER_MINUTE`, default 30). There's no daily cap. No per-IP limits, on purpose (no IP state). |
| TURN username/password are static and compiled into every client. A public PWA makes them public. | **Fixed** (`GET /api/turn/credentials` issues HMAC credentials that expire after 12 h by default; `relay-server/deploy/turnserver.conf` uses `use-auth-secret`, refuses to relay to private addresses and writes no logs). Paid for with an anonymous token since phase 3. |

### Decided: anonymous membership tokens (RFC 9474)

**What it provides:** cryptographic unlinkability between *who you are* (login) and *what you do* (every other request). Without it, every request carries your account id, so a perfect activity log exists by default, including by accident in proxy logs, error logs and crash dumps. With it, requests carry one-time tokens that even the server's own records can't connect to an account.

**How (RSA blind signatures):**

1. **Login (identified):** challenge-response. The server sends a nonce, and the client signs it with its ECDSA P-256 signing key. This is the only identified request.
2. **Blind:** the client invents random token values `m`, and for each picks a random blinding factor `r` and sends `H(m) · rᵉ mod n`. That number is uniformly random to the server; it reveals nothing about `m`.
3. **Sign:** the server signs the blinded values with its private key and returns them, counting them against the member's rate limit.
4. **Unblind:** the client divides out `r` and is left with a valid signature on `H(m)`: a token the server has never seen.
5. **Spend:** posting blobs, fetching blobs and getting TURN credentials each present one `(m, signature)`. The server checks the signature and that `m` hasn't been spent before. It can tell a member sent this, but even with full logs of issuance it can't tell which member: blinding makes every issuance session equally likely.

**Requirements:**

- **One issuer key for everyone.** If the server signed each member with a different key, the key would tag the tokens. Clients include the current issuer-key fingerprint inside their encrypted messages and warn on a mismatch. This is the one cross-check that stays: without it, a malicious *server* (not the admin) could quietly tag tokens per member and RFC 9474 would protect nothing.
- **Issuer key rotation: daily, and immediately when a member is removed.** The server can't revoke one member's tokens, because it doesn't know which tokens are theirs, so rotating the key is the only way to kill a removed member's leftovers. Everyone's unspent tokens die with it, and clients quietly fetch new ones.
- **Not on additions.** A new member has no old tokens to kill. Every rotation briefly shrinks the crowd: right after it, only the few members who have already refilled hold valid tokens. So extra rotations cost privacy and buy nothing.
- **Clients police rotations.** They accept a new key only on the daily schedule, or when it comes with a removal entry signed by an admin. Otherwise a malicious server could rotate keys constantly to split members into small, identifiable groups.
- **Refills:**
  - Each device keeps a **pool** of unspent tokens (e.g. 100). One token pays for one request, not one blob; a sync with a cursor is a single request.
  - When the pool drops below a threshold (e.g. 40) while the app is open, the app schedules a refill at a random moment in the next few minutes. A refill is one identified request (a login session) asking for a batch of blinded signatures, counted against a per-member rate limit.
  - iOS web apps don't run in the background, so refills only happen while the app is open. Topping up early, before the pool runs low, keeps "refill, then immediately use" from being the normal pattern.
  - **Receiving costs nothing.** Pushes are sent by the server and paid for by the *sender* (one token covers posting a message and its mention pushes). The service worker shows the notification from the encrypted push payload alone, with no network request, so being pinged all night spends none of your tokens. With the app closed nothing runs, so nothing is spent.
  - **Opening the app** costs one token for the sync, plus one per further page of backlog once syncs are paged. (An earlier draft had the first token open a 60 s anonymous sync session covering every page; dropped, since tokens are cheap under a rate limit and it would add server session state for a few tokens' saving.)
  - **Daily rotation keeps yesterday's key valid for 24 more hours**, so an overnight rotation doesn't empty pools and force a refill right on app open.
  - **Removal rotation has no overlap** (that's its purpose): every pool empties at once. The next app open must refill before syncing, which briefly links the identified refill to the anonymous requests that follow. This is accepted, because removals are rare. Refills after a rotation still happen after a random delay where possible.
- Web Crypto has no blind-RSA primitive: use a reviewed BigInt library or a careful implementation checked against the RFC's test vectors.

**Limits (honest):** it removes the account id from requests, but not the IP address. Against an operator who logs IPs:

- With **IP hiding** (VPN or Tor-style relay), tokens make requests genuinely anonymous. This is the only way sealed sender and anonymous fetching hold up against a logging operator.
- **Without IP hiding**, the operator falls back to IP and timing correlation. That's strong for a member on stable home Wi-Fi, but noisy on mobile networks, where IPs change often and many users share one (carrier NAT). It raises the bar from "the account id is in every request" to statistical guessing.

IP hiding is optional per member; members who want the strong guarantee should use it. Push registration is still identified (A, §9).

### As built (phase 3)

- **Join codes.** `RELAY-JOIN:` + base64url JSON `{ type: "relay-join", server, admins }`, shown in Settings → Admin as a QR of a link (`<app>#join=<code>`; the fragment never reaches any server). Joining pins the server URL and admin keys in the app. An app can join several servers and switch between them (menu above the chat list); each keeps its own identity, tokens and rollback state, keyed by URL. Opening a link to a server the app hasn't joined asks first. A build can still preset one server with `NEXT_PUBLIC_API_URL` + `NEXT_PUBLIC_ADMIN_SIGNING_KEYS`. Code: `relay-web/src/lib/server.ts`.
- **Admins live in the member list.** The directory carries `admins` (signing keys, each must be a member, at least one). Clients accept a list only if signed by an admin they already pin, then re-pin to its `admins`. The server trusts the newest list's `admins`; `ADMIN_SIGNING_KEYS` only authorizes the first list. Admins can make other members admins; a re-enrolled admin stays an admin; the last admin can't be removed.
- **One identity per server.** Joining a server creates a new identity for it, so servers can't link a member by key (they can still compare IPs and timing; see above). Identities are stored in IndexedDB keyed by server URL (phase 4).
- **First admin of a new server:** **Join a server → I'm setting up a new server** → enter the URL and your name → the app creates your identity for it and pins its key → **Create member list**, which the server accepts in one of two ways:
  - **Setup code** (servers installed by `deploy/install.sh`): the script makes a random 128-bit `SETUP_CODE` and shows it in its output and the SSH login message. The first member list may come with it (`X-Relay-Setup` header, over HTTPS), and its signer becomes the first admin. Once any list exists the code does nothing, so it can only ever be used once, and whoever uses it first is the admin: it's as secret as root on the server until then.
  - **By hand:** put the signing key the app shows in `ADMIN_SIGNING_KEYS` and restart.
- **Login:** `POST /api/auth/challenge` → nonce (60 s, single use) → sign `{ type: "relay-login", keyHash, nonce, server }` → `POST /api/auth/login` → 15-minute session, held in memory only. If `PUBLIC_URL` is set, `server` must match it, so another relay can't replay our signature. Sessions pay for token refills, admin requests and the socket. Removing a member ends their sessions and disconnects their sockets.
- **Tokens:** RFC 9474 RSABSSA-SHA384-PSS-Randomized, RSA-2048. The client uses `@cloudflare/blindrsa-ts`; the server signs with Node's native raw RSA (the library's pure-JS signing took ~300 ms per token) and checks its own output. Spent tokens are stored as a hash until their key expires. Header: `Relay-Token: <keyId>.<prepared msg>.<sig>` (base64url). Code: `relay-server/src/lib/tokens.js`, `relay-web/src/lib/tokens.ts`.
- **Wallet:** per server in `localStorage`: pool of 100, refill below 40 at a random moment in the next 2 minutes (at once when empty). Over the rate limit it takes what's available; with nothing at all it reports the wait to the caller (the send queue waits it out, a sync is rescheduled). One token per request: a whole message (all recipients + self-copy, up to 64 blobs) is one `POST /api/blobs?to=...`, and bursts of "refresh" pings are collapsed into one sync.
- **Issuer keys:** a daily key valid from UTC midnight for 48 h; on any member removal every live key ends at once and a `removal` key starts (valid to the second midnight). `GET /api/tokens/keys` also lists keys that ended in the last 7 days. The client accepts a daily key only on schedule and only one per day (and remembers which one it saw), and a removal key only if a removal in the signed member list from the previous 24 h accounts for it, one key per removal. Otherwise it shows a warning and won't use the key.
- **Key-consistency check:** every message carries the sender's issuer key id (`issuer`). A receiver that has never been shown that key by the server, or sees it break the schedule, shows a warning banner.
- **Admin tab:** join code, members (scan with the camera via `jsqr`, paste, make admin, remove), server status (counts, tokens issued today across all members, TURN, issuer keys). The removed-keys list is the signed member list's `removed`.
- **No logging:** no request logger; errors log a message only; Caddy has no `log` directive. CORS allows any origin (no cookies are used), so the official app, forks and local builds can all reach any server.
- **Rate limit, not a daily quota:** a per-member token bucket in memory (`TOKEN_BURST`, default 200 = two refills, then `TOKEN_RATE_PER_MINUTE`, default 30). It only stops one member flooding the server; a busy day of chatting never hits it. Full buckets are dropped, so idle members leave no trace.
- **Join codes don't expire.** A join code only says where the server is and which admin keys to trust; it grants nothing. Getting in still takes an admin approving your enrollment code, which expires after 3 minutes and needs the admin to check its fingerprint.
- **Sending:** messages go through a queue, one at a time, in order. A message shows faded until the server has taken every blob, then normal. Out of tokens (rate limit), the queue waits for the server's `retryAfter` and carries on, however long that takes. Unreachable server or 5xx: retries after 2, 5, 10, 20 and 30 s, then fails. Any other 4xx (refused, e.g. removed member): fails at once. A failed message shows "Not sent" with retry and cancel (✕) icons; retry resumes from the first batch not taken. Not persisted: closing the app drops queued messages.
- **Push** came in phase 7, per device (§9, as built).

---

## 7. Calls

| Decision | Status |
| --- | --- |
| WebRTC mesh, Socket.io signaling, STUN plus optional TURN. Media is DTLS-SRTP peer-to-peer. | Current |
| The room id was a SHA-256 of the sorted member key hashes, so anyone who knew the members could compute it. | **Replaced** (phase 6): random room ids, below |
| SDP (including DTLS fingerprints) passed through the server **unauthenticated**, so the server could man-in-the-middle a call. | **Fixed** (phase 6): sealed signaling, below |
| `join_room` accepted a client-*asserted* key hash, the first joiner set the room's allowed list, and clients sent an offer (with mic/camera) to any peer that appeared, so anyone who knew the hashes could join and receive media, or squat a room id. | **Fixed**: the socket's key hash comes from its login session (phase 3); room ids are random and only shared inside encrypted messages; offers and answers are sealed to conversation members only (phase 6) |

### As built (phase 6): call security

- **Sealed signaling** (`relay-web/src/lib/callSignal.ts`): every offer, answer and ICE candidate is AES-GCM encrypted to the one peer it's for, with a key from HKDF over the static ECDH secret between the two members, salted with the room id and bound to the direction, and carries a timestamp (refused if more than 2 minutes off). The server forwards only `{ from, fromKeyHash, sealed }`, where `fromKeyHash` is the sender's logged-in member, and drops unsealed signals. If the server names the wrong sender, decryption fails.
- **Media only to verified peers:** signals are sealed to, and accepted from, only members of the call's conversation. The SDP and its DTLS fingerprint are inside the sealed envelope, so only that member can complete the connection, and the server can't sit in the middle.
- **Random room ids:** whoever starts a call picks a random 128-bit room id and announces it in the encrypted "call started" message. Others join the room named by the conversation's latest "started" event, until an "ended". The Call button says **Join call** while one is going. Known limit: two people starting a call at the very same moment end up in two rooms.
- **Tiles for members not in the call:** dimmed "not in call" tiles under the call, with **Notify** (a ring push, phase 7).
- The wrapper sits around the call socket, so the existing WebRTC code is unchanged; signals to and from each peer are kept in order.
- **Surviving a network change** (a phone moving between Wi-Fi and cellular). Two things break, and each is repaired:
  - *Signaling:* the socket reconnects under a new id and is no longer in the room. The app joins again as if new (dropping every peer connection) and the others connect to the new id. The server tells a room when a socket drops (`peer_left` on disconnect) and pings every 10 s with a 10 s timeout, so a dead socket is noticed in about 20 s; a peer that sees the same device join under a new id drops its old tile at once.
  - *Media:* when a peer connection goes `failed` (or stays `disconnected` for 5 s) while signaling still works, the side with the lower socket id replaces it with a fresh connection and offer; the other side answers it as usual. Only one side acts, so the two never offer at once.

### Decided: call tiles for everyone in the conversation

- During a group call, every conversation member gets a tile. Members not in the call show as a dimmed "not in call" rectangle with a **Notify** button that sends them a ring push (§9).
- It says "not in call", not "offline". The app only knows who has joined the room. Real online/offline presence would need the server to track who is connected, which is the kind of metadata Exurelay avoids.
- Starting or joining a call never notifies anyone by itself. Only **Notify** sends a ring. Rings are rate-limited per person (e.g. one per 30 s), and the receiver can mute rings per conversation.

Recommended fix: authenticate signaling end to end. Seal each offer/answer/ICE message with the pairwise key (the same ECDH as messages) so the server routes only opaque envelopes, and attach media only to a verified peer. Rooms use random ids shared inside encrypted messages instead of deterministic ones.

---

## 8. Clients

| Decision | Status |
| --- | --- |
| A message's sender was taken from the decrypted JSON (`senderKeyHash`) without checking it against the key that encrypted it. Any member (or anyone holding a member's public key) could impersonate any contact. | **Fixed** (`assembleVerifiedMessages` in `relay-web/src/lib/blobChunk.ts`, tests in `senderVerification.test.ts`) |
| Web: `identity.bin` (with the private key) is served from `public/identity/`, and `PUT /api/identity` overwrote it. `next dev` listened on all interfaces, so anyone on the LAN could download or replace your identity. | **Fixed** (phase 4): `public/identity/` and `/api/identity` are gone, which also closes the DNS-rebinding gap; the identity is a passphrase-encrypted file the dev server never sees, or non-extractable keys in IndexedDB. The web app is now fully static, so it can also be hosted. |
| iOS app: received filenames were used as cache paths unsanitized, so `../identity.bin` could overwrite the identity file. | **Fixed** (`safeFilename` in `page.tsx`, still used for downloads); the iOS app is gone (phase 10) |
| iOS app: `identity.bin` was exposed in the Files app and in backups. | **Gone** with the iOS app (phase 10); in the PWA, keys live in IndexedDB or the encrypted identity file |
| Images are re-encoded through a canvas to strip EXIF/GPS before sending. | Current |
| Only messages from known contacts (or yourself) are shown. Contact cards received in chat are displayed, never auto-added. | Current |

### Decided: @mentions

- **Composing:** typing `@` opens a picker of the conversation's members, labeled with *your* names for them (display names are local to each user). The message stores the mentioned **key hashes** in a `mentions` field inside the encrypted content, never names.
- **Rendering:** each viewer shows a mention using their own name for that person. Mentions of you are highlighted, the message gets a highlight bar, and the conversation shows a mention badge until you read it.
- **Notifications:** the sender's client asks the server to push each mentioned member (§9). Mentioning someone who isn't your contact sends nothing.
- **`@everyone`** mentions every member of the conversation and notifies each of them.
- **Rate limits are per recipient**, enforced by the server (it knows push targets under A, §9): each member gets at most a few mention pushes per minute in total, and at most one `@everyone` push per minute, whoever sends them. Extra mentions aren't lost; they show up, highlighted, the next time the app opens.
- Mentions are the *only* thing that notifies, in groups and DMs alike (§9).

**As built (phase 5c),** without the notifications, which come with push in phase 7 (`relay-web/src/lib/mentions.ts`):

- **Format:** a text message's body carries `<@keyHash>` or `<@everyone>` tokens where the mentions are, and `mentions` lists them, all inside the encrypted message. A mention counts only if it's both listed and in the body. `@everyone` counts only in a group you're in. Your own messages never count as mentioning you.
- **Composing:** typing `@` at the start or after a space opens a picker of the conversation's other members by your names for them, plus `@everyone` in groups. Arrow keys and Enter/Tab pick, Esc closes. The draft shows `@Name`, and sending turns each picked name into its token.
- **Rendering:** each mention shows as `@` plus *your* name for that person. Mentions of you (or `@everyone` in your groups) are amber, and the message gets an amber bar on the left.
- **Badge:** the sidebar shows `@N` on a conversation with N unread mentions of you. A conversation counts as read up to its newest message while it's open and the app is in front. The read markers are saved with the sync cursor in the encrypted cache, and kept through a re-sync.

---

## 9. Distribution, customization and notifications

### Distribution routes

| Route | Paid Apple account? | Verdict |
| --- | --- | --- |
| App Store / TestFlight | Yes | Excluded |
| Firebase App Distribution | **Yes.** iOS builds must be ad hoc–signed with each tester's UDID in the provisioning profile, which needs the paid Developer Program. | Not viable |
| EU alternative marketplaces | Yes (plus Apple notarization) | Not viable |
| Sideload (SideStore, free Apple ID) | No | **Removed** (phase 10) |
| **PWA (Add to Home Screen)** | No | **Decided**: the only mobile route |

### How a Home Screen web app compares to a native app (iOS 16.4+)

| Works like an app | Differs from an app |
| --- | --- |
| Own icon, opens full-screen without browser bars, appears in the app switcher | Installed from Safari's Share → **Add to Home Screen** (other iOS browsers can too), not an app store |
| Its own storage, separate from Safari's, and exempt from Safari's 7-day storage cleanup | Deleting the icon deletes its data, including the identity; with no backups (§4) that means re-enrolling |
| Push notifications and the badge count | No background execution: calls will likely drop or mute when you leave the app or lock the phone (test this), and incoming calls can only arrive as a notification, never a ringing call screen |
| Camera, mic and WebRTC calls while open | Can't receive "Open with…" from AirDrop or Files (not needed: keys are generated in-app) |
| Works offline (service worker) | Updates apply on next launch with no review step, so whoever hosts the build can change it at any time |

### As built (phase 7): the official PWA

- **Static export** (`output: "export"`): `npm run build` writes plain files to `relay-web/out/`, and `npm start` serves them locally with no dependencies (`scripts/serve.mjs`). `BASE_PATH` serves it under a path (a GitHub Pages project site).
- **Strict CSP** (`scripts/postbuild.mjs`): a static host can't set headers, so every page gets a `<meta>` CSP. Scripts only from this origin plus the exact inline scripts Next emitted (SHA-256 hashes), so an injected script can't run. `connect-src` allows any HTTPS/WSS server, because the app talks to whichever servers you join. `object-src 'none'`, `base-uri 'none'`, `form-action 'none'`, and frames only from `blob:` (plugins, phase 8). Styles allow `'unsafe-inline'`, because React sets style attributes.
- **Published builds** (`.github/workflows/deploy-web.yml`): on each push to `main`, it tests, builds and publishes to GitHub Pages. `out/build.json` carries the commit and a SHA-256 over every published file; the workflow prints it in the run summary, and the app shows it in Settings → General. Not yet reproducible bit for bit: Next builds can differ between machines, so the hash proves "this is what that run published", not "anyone rebuilding gets the same".
- **Installable:** a manifest, icons (`scripts/icons.py` draws them), and a service worker (`public/sw.js`). The service worker caches only the app's own files (pages network-first, hashed build files cache-first), never anything from an Exurelay server. Once installed, the app asks for persistent storage.
- **Install first on phones:** on a phone, the join and create-identity screens are replaced by install instructions (Share → Add to Home Screen on iOS; Install app on Android) until Exurelay runs as the installed app, so an identity can't end up in a browser tab's separate storage. `?browser` skips this, for development.
- **Push** (A, below): the server holds `PushSubscription { endpoint, device, member }`, registered by a logged-in device (Settings → General → **Turn on notifications**). Senders pay with an anonymous token to `POST /api/push/notify { kind, items: [{ device, payload }] }`, where each payload is encrypted device to device by the sender (`relay-web/src/lib/push.ts`: HKDF over the static ECDH secret, AES-GCM, `{ kind, member, group, ts }`). Limits per recipient member (`relay-server/src/lib/pushLimits.js`): 5 mentions a minute, one `@everyone` a minute, one ring per 30 s. Nothing about who was notified is stored or logged. Subscriptions go when the member is removed or the device unlinked. Disabled unless the server has VAPID keys (`npm run vapid`).
- **Showing a push:** the service worker reads this device's key from IndexedDB (app-storage mode), decrypts the payload, checks the sending device belongs to the member it names and that it's under a day old, and shows e.g. "Ana mentioned you in Trip" with *your* name for Ana. For that, the app keeps a `pushPeers` list in IndexedDB: contacts' device public keys and your names for them, in the clear (names and keys, no messages). In folder mode, or if anything doesn't check out, the notification is generic ("You were mentioned in Exurelay").
- **Only addressable devices:** senders fetch which devices have notifications on (`GET /api/push/devices`, members only; the server knows this from the subscriptions anyway) and name only those, and send nothing if the server has push off. So a mention of someone who can't be notified never reaches the server; it learns a mention target only when a push actually goes out.
- **Notify** on a "not in call" tile rings that member's devices.

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
- ~~**Safe mode**~~ **Dropped:** plugins are sandboxed and never touch sending, and Settings → Plugins can always turn one off.
- The wire format can't be changed by plugins. Wire changes are versioned core releases.

**As built (phase 8), plugin API v1** (`relay-web/src/lib/plugins.ts`, `public/plugin-host.html`):

- **Install:** Settings → **Plugins**, from a URL or a file. The app shows the code's SHA-256 before you accept and pins that exact code in IndexedDB. **Check for update** re-downloads a URL plugin and asks again if the hash changed. Plugins can be turned on and off, or removed.
- **Sandbox:** each enabled plugin runs in its own `<iframe sandbox="allow-scripts">` of `plugin-host.html`: an opaque origin, so no access to keys, the cache, cookies or storage, and no popups or navigation. That page has its own CSP: `default-src 'none'` (no network at all), and scripts only by hash (its own inline host script; `'self'` matches nothing in a sandboxed page) plus `'unsafe-eval'`, so the plugin's code (sent over `postMessage`) can run there and only there. A test checks the hash matches the script. The app's own CSP still forbids eval, and only allows frames from itself.
- **What a plugin can do** (`relay` object):
  - `setTheme(vars)`: only the six color variables, with color values (no `url()`).
  - `registerMessageType("x-<name>/<type>", { render })`: renders that type as plain text (0.5 s budget). Without the plugin, people see the sender's fallback text and the type.
  - `send(type, data, fallback)`: always asks you to confirm, then sends to the open conversation (data at most 16 KB).
  - `onBeforeSend(fn)`: may change a text before it's sent (0.5 s budget).
  - `onMessage(fn)`: read-only messages as they arrive in the open conversation.
  - `root`: its own screen, shown from Settings → Plugins → **Open**.
- **Not in v1:** replacing built-in screens or components, and after-decrypt hooks that change messages. Plugin message types are part of the encrypted content (`type: "plugin"`); the wire format itself never changes for plugins.
- **No safe mode:** plugins never touch how blobs are sealed or sent (recipients, decoys, blob size, tokens), and any plugin can be turned off in Settings → Plugins.

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
3. **Payload:** a small Exurelay-encrypted blob (pairwise key), wrapped in Web Push encryption to the device. The server forwards opaque bytes. The service worker decrypts it with the identity in IndexedDB and shows, e.g., "Alex mentioned you in Trip" using *your* name for the sender.
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
| G | **Separate push proxy:** a second, independently run server holds endpoints and sends pushes; the relay never sees endpoints | Exurelay: nothing about devices. Proxy: wake-ups, but no blobs | Only helps if the two operators don't collide. Senders can't call Apple's push service straight from the browser (CORS, likely; unverified), so a proxy is needed for any "sender pushes directly" design. |
| H | **Cover pushes** (fake wake-ups to hide real ones) | — | **Not possible on iOS:** every push must show a visible notification. |

Chosen: **A**, limited to mentions and manual call rings, with no push logs (above). B–F only help against an operator who logs, and IP correlation defeats them without IP hiding; G only if a second, trusted operator exists.

**Alternatives considered** (all compatible with recipient-blind storage, but worse notifications):

- **Generic throttled push:** the server pushes every member at most once every N minutes ("New activity in Exurelay"); the service worker syncs and updates the badge. It reveals nothing about recipients, but it's vague, and people get pinged for messages that weren't for them.
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
| 2 | Self-generated identities | **Done**: client keygen + identity format v5 (adds an ECDSA signing key, drops `myUserNumber`); server `Member` table with public keys replacing `AllowedKey` hashes; admin keys in server config; signed QR codes with 3-minute expiry; admin-signed member directory with version check; key-change notices; retire `generate-20-identities.mjs`; hard cutover (wipe server, re-enroll everyone) | 0 |
| 3 | Login, tokens and admin | **Done** (see §6 "As built (phase 3)"); also added join codes so one app build works with any server. Challenge-response login; RFC 9474 blind-token issuance, daily issuer-key rotation, key-consistency check, spent-token store; per-member token rate limit; move the TURN credentials endpoint behind a token; no request/IP logging; Settings → Admin tab (admin labels, camera QR scan, signed revocation list, server status; basic enroll/remove already shipped in phase 2) | 1, 2 |
| 4 | Key storage | **Done**: desktop Chrome/Edge keep a passphrase-encrypted identity file in a folder you pick, with a setup popup and an unlock screen; other browsers and phones keep non-extractable keys in IndexedDB; in-app key generation; removed `public/identity/`, `/api/identity` and the plain `.bin` file; persistent-storage request; linked devices decided as per-device keys. The wallet and rollback version stay in `localStorage`: they're plain data cleared with the same site data, so IndexedDB would add nothing. | 2 |
| 5 | Protocol v2 | **5a done** (§5 "As built (phase 5a)"): sealed sender + recipient-blind blobs, each send encrypted once with a slot per recipient; `GET /blobs?since=` cursor; admin-set blob size and decoys; attachments travel like messages; stable `messageId`. **5b done** (§5 "As built (phase 5b)"): encrypted local cache, Settings → Storage tab. **5c done** (§8 "@mentions", as built): `mentions` field + picker, `@everyone`, highlight and badge. **5d done** (§4, as built): linked devices with per-device keys, device certificates, settings sync, Settings → Devices | 3, 4 |
| 6 | Call security | **Done** (§7, as built): sealed offer/answer/ICE with pairwise keys; random room ids; media only to verified peers; tiles for members not in the call | 3 |
| 7 | Official PWA | **Done** (§9, as built): static export; manifest, icons, service worker; `storage.persist()`; strict CSP; GitHub Pages workflow publishing commit + build hash; push (A, per device, no push logs, per-recipient limits) + service worker that decrypts and shows mention/ring notifications; call-tile **Notify**; install-first on phones and install guide | 1, 3, 4 |
| 8 | Plugins | **Done** (§9, as built): sandboxed iframe host + versioned `postMessage` API (v1); install from URL/file with hash pinning; themes; plugin message types with fallback text; before-send hook; own screens. Not in v1: replacing built-in components. No safe mode | 7 |
| 9 | Fork and deploy | **Done**: deploy workflow (Pages, `BASE_PATH`); protocol v2 test vectors in CI (`vectors.test.ts`); [FORKING.md](FORKING.md) | 5, 7 |
| 10 | Remove Capacitor app | **Done**: `relay-mobile/`, its README section and `@capacitor/*` removed; phones use the installed PWA | 7 |
| 11 | Docs and tests | **Done**: README and relay-web/README rewritten for the PWA; tests for login/tokens, protocol v2 (plus vectors), devices, sealed signaling, push, plugins, mentions, the cache; CI workflow (`.github/workflows/test.yml`) | each phase |
| 12 | Setup and call recovery | **Done**: `deploy/install.sh` (one command on any Ubuntu host, also an upgrade), `deploy/cloud-init.sh` (user data), `deploy/aws-lightsail.yaml` (CloudFormation); free `https://<ip>.sslip.io` addresses by default, own domain optional; one-time setup code instead of copying the admin key; the server loads `.env` itself; calls recover from network changes (§7) | 11 |
| 13 | Easier setup and backups | **Done**: a setup code chosen when creating the server (CloudFormation `SetupCode`, `RELAY_SETUP_CODE`, `--setup-code`), so nobody needs to log in to the server; the app waits for a server that's still installing; nightly backups without messages (§5) and `install.sh --restore` to move a server; daily security updates; a Launch Stack link published to S3 by `.github/workflows/publish-template.yml` | 12 |
| 14 | Less in plain text | **Done**: display names sealed to every member's devices and device names to the member's own devices (§4 "Names"), both previously public; admin labels removed; the worker no longer logs deletion counts; apps refresh the member list as soon as the server announces a change; §1 lists what the server still stores in plain text | 13 |
