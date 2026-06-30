# Maurice — v1 Spec

*A small Claude for home.*

## What Maurice is

A native chat app for households. Conversations live on a server you run yourself; clients connect to it over HTTPS. The chat experience is fully native (Mac, iOS). Administration is a small web UI on the same server.

Maurice differentiates from cloud chatbots by being yours: your data stays on hardware you control, your household has its own accounts, there is no analytics, no engagement loop, no email signup. It differentiates from existing self-hosted chat tools (Open WebUI, LibreChat, Khoj) by being a real native app rather than a browser dashboard.

## v1 milestone

A working Maurice that Candide's household uses daily. Shipped to GitHub as a public artifact by mid-July 2026.

Success criteria: Théo and a sibling can open Maurice on the shared family iPad, pick their user, enter a PIN, and have a real conversation with Maurice that streams in fluidly. Candide can administer the household from his Mac. The whole thing runs on the home Mac Mini, reachable via Tailscale.

## v1 includes

- A Mac app that installs Maurice's server and launches it at login.
- A native installer that handles initial setup: admin username, admin password, API key (optional), HTTPS endpoint configuration.
- A server that exposes an HTTPS API for clients, with auth, users, conversations, messages, and streaming chat.
- A web admin UI served by the server, reached at the configured HTTPS URL, for managing household members.
- A native iOS app that pairs once per device via QR code, supports multiple users with PIN switching, and renders Maurice's chat experience to the design language already established.
- Streaming chat backed by the Anthropic API, with Maurice's own provider-agnostic streaming protocol between server and client.

## v1 explicitly does not include

- A native Mac chat app (Mac is admin/server only in v1).
- Local model inference (Ollama integration is v2).
- Notes, garden, signals, coaching, dreams, daily notes, or any other Akita workflow. v1 is chat only.
- A plugin system. The data model should leave room for one; the implementation is v2.
- Offline composition or sync. Clients require the server to be reachable.
- Self-service signup, password recovery emails, or email of any kind.
- Conversation forking, branching, file uploads beyond plain images, or other chat-power-user features. Chat in v1 is a single linear conversation with text and image input.
- Cross-household features (sharing, federation, etc.). Maurice is single-household per server.
- App Store distribution. TestFlight is the v1 distribution channel for iOS.

## Architecture

**Server.** A single process running on the admin's Mac, launched at login by the Mac launcher app. Listens on a configured HTTPS endpoint (Tailscale, Cloudflare Tunnel, or any other HTTPS-providing layer — Maurice doesn't manage TLS itself). Stores everything in SQLite at a known path under the user's Application Support directory.

**Mac launcher.** Minimal SwiftUI menu bar app. Shows server status (running, errors). Opens the admin web UI in the default browser when clicked. Handles installation, launch-at-login, and the first-run setup screens.

**Web admin.** Server-rendered HTML at the HTTPS endpoint, reached in a browser. Single purpose: manage household members (add, edit, remove, reset PIN). Also exposes API key configuration and server status. Login required (admin credentials set during installer).

**iOS app.** Native SwiftUI app. Pairs once per device via QR code scanned from the admin web UI. Stores per-user session tokens in the device keychain. Supports fast user switching with optional PIN per user. Talks to the server's API over HTTPS.

**Provider abstraction.** The server talks to Anthropic's API on the backend but exposes its own streaming protocol to clients. This keeps clients decoupled from any specific provider and leaves the door open for Ollama or other backends in v2.

## Data model

Five tables in SQLite:

- `households` — single row in v1, but the concept exists. Holds household-wide settings (API key, default model, etc.).
- `users` — id, household_id, username, display_name, role (admin/standard), password_hash (admin only), pin_hash (nullable, for standard users), created_at, last_active_at, profile_text (optional self-description for Maurice's context).
- `sessions` — id (opaque token), user_id, device_id (for grouping tokens issued to the same paired device), created_at, last_used_at, expires_at (nullable).
- `conversations` — id, user_id, title (nullable; auto-generated after first exchange), created_at, updated_at.
- `messages` — id, conversation_id, role (user/assistant), content, model (which model generated this, if assistant), created_at.

Future tables (signals, notes, etc.) are out of scope but the schema should not preclude them.

## API surface

All endpoints HTTPS, JSON request/response unless noted.

**Auth.**
- `POST /api/auth/pair` — device pairing. Accepts pairing token (from admin web UI QR), returns device_id and an admin-level provisioning token used to add users to the device.
- `POST /api/auth/login` — accepts user_id and PIN (or password for admin), returns session token. Used during user switching on a paired device.
- `POST /api/auth/logout` — invalidates current session token.

**Users.**
- `GET /api/users` — list household users. Available to any authenticated client (the iPad needs to know which users are on the device); returns minimal info (id, display_name, avatar_color, has_pin).
- `GET /api/users/me` — current user's full profile.
- `PATCH /api/users/me` — update own profile_text, display_name.
- Admin-only endpoints (`POST /api/admin/users`, `PATCH /api/admin/users/:id`, `DELETE /api/admin/users/:id`) are served by the web admin, not exposed to native clients in v1.

**Conversations.**
- `GET /api/conversations` — list current user's conversations, newest first.
- `POST /api/conversations` — create a new (empty) conversation.
- `GET /api/conversations/:id` — get conversation metadata and messages.
- `PATCH /api/conversations/:id` — rename.
- `DELETE /api/conversations/:id` — delete.

**Messages.**
- `POST /api/conversations/:id/messages` — send a message and stream Maurice's response. Returns a streaming HTTP response in Maurice's event format.

**Streaming format.** Server sends newline-delimited JSON objects over a chunked HTTP response. Event types: `text_delta` (incremental token), `done` (response complete, includes final message id), `error` (recoverable or fatal, includes message). Client can cancel by closing the connection. Server translates Anthropic's SSE format into this internally.

## First-run flow

The installer is a native macOS app, runs once on first launch after install. Four screens:

1. **Welcome.** Brief intro: "Maurice is a small chat app for your household. Let's set it up." Continue button.
2. **Create admin account.** Username and password. No email. A note: "This is the account you'll use to manage Maurice. You'll add household members in the next step."
3. **Connect to an AI.** Field for Anthropic API key, with a link to where to get one. Includes a brief plain-language note about what the key is for and what gets sent to Anthropic. Skippable; Maurice will prompt the admin to set this up later from the web admin if skipped.
4. **HTTPS endpoint.** Field for the URL Maurice should be reachable at (Tailscale hostname, Cloudflare Tunnel domain, or similar). Defaults to a Tailscale-detected hostname if Tailscale is installed and authenticated. Includes a note: "Maurice doesn't manage TLS itself — it relies on Tailscale, Cloudflare Tunnel, or whatever HTTPS layer you use. Help if needed at [docs link]."

After the installer exits: the launcher starts the server. The admin's browser opens automatically to the web admin URL, where they log in with the credentials they just set. They're now in the admin UI, ready to add household members.

## Adding household members (web admin)

A simple form: display name, optional PIN, avatar color. Submitting creates the user. Each user can be edited or deleted later.

To set up the user on the family iPad: the admin generates a pairing QR code from the web admin. The iPad's Maurice app scans it; the iPad is now paired to this Maurice server, with the admin's provisioning context. The admin then taps each household user from a list in the iOS app, which adds that user to the device (provisioning a session token stored locally per-user). After this is done, the iPad shows a user picker on launch: tap your avatar, enter PIN if set, you're in.

## iOS app: structure

**First launch (unpaired).** Screen explains: "Maurice runs on a computer in your home. To use it, scan the pairing code from the Maurice admin screen on that computer." Camera button. Manual URL entry as a fallback.

**Paired, no users yet on device.** Empty state with a button to add a user. Tapping it shows the household roster (fetched from the server); admin selects which users belong on this device. Each selected user gets provisioned and stored locally.

**Paired, users on device.** User picker screen on app launch. Tap an avatar; if the user has a PIN, prompt for it; on success, enter chat as that user. On idle timeout (default: 1 hour), app returns to user picker.

**Chat (active user).** The chat surface from the design mockups. New conversation, conversation list, send messages, streaming responses. Compact user switcher (avatar in toolbar) lets the user return to the picker to switch.

## Web admin: structure

Single-page, four sections:

- **Household members.** Add, edit, delete. Set or clear PIN per user. Generate pairing QR for a device.
- **AI settings.** API key, default model, max tokens per response, monthly budget (visible to admin, surfaces on user accounts as the meter).
- **Server.** Endpoint URL, version, status, log tail (last 100 lines), restart button.
- **About.** Maurice version, link to GitHub, support email.

Plain HTML with light interactivity. No SPA framework. Server-rendered.

## Tech stack

- **Mac launcher:** Swift / SwiftUI.
- **Installer:** Same Swift binary as the launcher; first-run mode shows installer screens.
- **Server:** Open question; default to whatever lets Candide ship fastest. Vapor (Swift) keeps everything in one language; Node or Python are alternatives. Decision needed before coding starts.
- **Database:** SQLite. Embedded, no separate process, ships in the binary.
- **iOS app:** Swift / SwiftUI.
- **Web admin:** Server-rendered HTML, light JavaScript only where necessary. No framework. HTMX is acceptable if it makes life easier.
- **HTTPS:** External — Tailscale, Cloudflare Tunnel, or admin's choice. Maurice binds to the local interface that the HTTPS layer reverse-proxies to.

## Build order

1. Write this spec. (Done with this draft; refine.)
2. Decide server language. Commit.
3. Server: auth, users, sessions. CLI-testable. Admin role + standard user role.
4. Server: conversations, messages, persistence. Echo-back responses (no Anthropic yet).
5. iOS app: pairing flow, user picker, chat UI wired to the real backend. Test with echo-back.
6. Server: Anthropic integration with Maurice's streaming protocol. Verify chat feels right end-to-end.
7. Web admin: household member management, pairing QR, AI settings.
8. Mac launcher and installer: package everything, first-run experience, launch-at-login.
9. Internal use by Candide's household. Iterate on what's actually missing.
10. Public flag-in-the-ground: GitHub repo, README, TestFlight invite for early users. Mid-July target.

## Open questions

- Server language. Vapor for Swift-everywhere coherence vs. Node/Python for velocity.
- Default theme: light-cream (mockup #2) or system-following with dark as alternative. Probably light-cream default; pick deliberately.
- Avatar color picker UX in the web admin: predefined palette or freeform.
- What happens to a user's conversations when the admin deletes the user: hard delete, soft delete with admin override, or export-then-delete. v1 can be hard-delete with a confirmation; revisit if it feels wrong.
- Backup/export of conversations: probably out of scope for v1 but worth not painting into a corner. A simple "export everything as JSON" admin button would be a small lift and is reassuring to users.
