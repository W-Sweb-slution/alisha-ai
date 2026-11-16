# ALISHA AI Social Studio

The existing full-screen ALISA AI chat keeps its liquid glass interface and **Prepare post** flow. Step 1 adds first-party email/password access at `/login` and `/register`; the protected chat and Connect Your Accounts page remain in the same app.

## Run locally

1. Use Node.js 24 (the deployment runtime pinned in package.json).
2. Copy `.env.example` to `.env` (or check that the supplied `.env` is present).
3. Set `SESSION_SECRET` as described below.
4. Run `npm install` and `npm start`.
5. Open `http://localhost:3000`.

## Render deployment

Use the existing application with the paid persistent-disk Blueprint in `render.yaml`. Follow [docs/render-deployment.md](docs/render-deployment.md) for exact settings, environment variable names, and the maintenance-first database transfer. Do not enable user traffic before importing the existing database and preserving its encryption keys. `/healthz` is the public readiness probe; `npm start` retains the local workflow.

### Authentication setup

Set `SESSION_SECRET` in `.env` to a unique cryptographically random value of at least 32 characters. Generate one with:

```sh
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

The checked-in `.env.example` contains no secret values; set `SESSION_SECRET` before startup. User records, persistent sessions, and encrypted Google connection records are stored in SQLite at `AUTH_DB_PATH` (default `data/alisha-auth.sqlite`); keep this file on persistent storage and back it up securely. `TRUST_PROXY=1` should only be used behind the trusted deployment proxy. In production set `NODE_ENV=production`, use HTTPS, and configure proxy trust. Generate a session secret for a new installation; preserve the existing session secret and encryption keys when transferring the existing database.

Unauthenticated visitors are redirected to `/login`; new users can register at `/register`. Passwords are normalized and hashed with Argon2id. Sessions are stored server-side in SQLite, use HTTP-only, SameSite=Lax cookies (Secure in production), rotate at login/registration, expire after seven days, and are invalidated at logout. State-changing API calls require the server-issued CSRF token. Login and registration are rate-limited.

Existing chat history keys are migrated into an authenticated-user namespace in browser local storage to keep different users on the same browser separate. Chat content remains browser-local and is not encrypted at rest.

## Google Sheets integration

This integration uses [Google's official `googleapis` Node.js client](https://github.com/googleapis/google-api-nodejs-client). In the existing Google Cloud project:

1. Enable the Google Sheets API.
2. Configure the OAuth consent screen and add development accounts as test users if the app is in testing mode.
3. Create or use a Web application OAuth client and add this exact local authorized redirect URI:

   `http://localhost:3000/api/google/callback`

   The redirect must match the URI sent in `GOOGLE_REDIRECT_URI` exactly, including scheme, port, path, and trailing slash. This is the local URI from the current `PORT=3000` project configuration. A deployed environment needs its own URI using that deployment's actual HTTPS origin; no production hostname is configured in this repository.

4. Set `ALISHA_ADMIN_EMAIL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `GOOGLE_SPREADSHEET_ID`, and `GOOGLE_TOKEN_ENCRYPTION_KEY` in the server `.env`. `ALISHA_ADMIN_EMAIL` must be the exact email of the developer's existing Alisha login account; do not use a Google email unless it is also that app account email. The example file contains no credentials. Generate the encryption key with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Keep it stable and backed up securely; changing it without re-encrypting stored records makes existing Google connections unreadable.
5. Ensure the developer's Google account has edit access to the configured spreadsheet, then sign in to Alisha using the account matching `ALISHA_ADMIN_EMAIL` and open **Connect Your Accounts** to manage the central database connection. Regular users do not authorize Google.

The flow requests `openid`, `email`, `profile`, and the Sheets scope, with offline access for refresh tokens. Google's [web server OAuth guide](https://developers.google.com/identity/protocols/oauth2/web-server) requires an exact redirect URI match and documents offline refresh-token access. OAuth state is random, session-bound, time-limited, and single-use. Set `ALISHA_ADMIN_EMAIL` to the email address of the developer's existing Alisha application account; only an authenticated session with that exact normalized email can manage the central connection. No user is promoted automatically. Access and refresh tokens remain AES-256-GCM encrypted in SQLite. The singleton `google_app_connection` record stores the application-level connection; on first access, an existing legacy connection belonging to the configured admin application account is copied without deleting its original row. Token refresh updates the central encrypted record. Disconnect revokes and removes only the central record. OAuth secrets and tokens never enter frontend JavaScript or local storage.

On successful authorization the app creates these tabs if absent and writes the expected header rows if the tabs are empty: `Conversations`, `SocialAccounts`, `PublishingRequests`, `ScheduledPosts`, and `UserSettings`. Existing non-empty rows and header values are not overwritten. All five database tabs use the single administrator-managed central spreadsheet connection. The server-side `GoogleSheetsIntegration` helpers force a `userId` from the authenticated session on writes and filter reads, updates, and deletes by that user ID. Regular users need no Google account and cannot access Google connection management routes. They whitelist columns, use RAW value input, and reject credential-like fields/values. The row writes use Google's [Sheets values API](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/append). No API route returns spreadsheet rows.

| Sheet | Header columns, in order |
| --- | --- |
| `Conversations` | `userId`, `conversationId`, `sessionId`, `role`, `content`, `createdAt`, `metadataJson` |
| `SocialAccounts` | `userId`, `accountId`, `platform`, `platformUserId`, `accountName`, `accountUsername`, `profileImage`, `connectionStatus`, `isDefault`, `createdAt`, `updatedAt` |
| `PublishingRequests` | `userId`, `requestId`, `socialAccountId`, `platform`, `mediaType`, `caption`, `mediaReference`, `publishingStatus`, `scheduledAt`, `createdAt` |
| `ScheduledPosts` | `userId`, `scheduledPostId`, `requestId`, `socialAccountId`, `platform`, `mediaType`, `caption`, `mediaReference`, `scheduledAt`, `publishingStatus`, `createdAt`, `updatedAt` |
| `UserSettings` | `userId`, `settingKey`, `settingValue`, `updatedAt` |

**Spreadsheet access boundary:** the central developer Google account must have edit access to the configured spreadsheet. Alisha enforces per-user `userId` filtering in backend helpers; anyone separately granted direct spreadsheet access can still inspect or change the file outside Alisha. Do not share the spreadsheet directly with regular users.

Central connection management routes are restricted to the authenticated account matching `ALISHA_ADMIN_EMAIL`: `GET /api/google/status`, `GET /api/google/connect`, `GET /api/google/callback`, `POST /api/google/sheets/initialize`, and `POST /api/google/disconnect`. State-changing routes use the existing CSRF middleware. The Google Sheets management panel is shown only to that administrator. The existing chat and publishing webhooks and their request payloads are unchanged.

The ALISA chat proxy reads the server-only `ALISA_CHAT_WEBHOOK` environment variable. Publishing uses its separate existing `N8N_WEBHOOK_URL`. Copy the current values privately to the deployment environment; neither URL belongs in frontend JavaScript or a public repository. Production environment variables take precedence over a local .env file.

## Request contracts

The chat request uses JSON `chatInput`, the active `sessionId`, and Base64 data URL attachments. Publishing remains on its existing endpoint and payload.

### Chat

`POST /api/chat` accepts JSON and forwards this body unchanged to `ALISA_CHAT_WEBHOOK` using HTTP POST with `Content-Type: application/json`:

```json
{
  "chatInput": "Write a caption for this launch",
  "sessionId": "existing-browser-session-id",
  "attachments": [
    {
      "name": "photo.jpg",
      "type": "image/jpeg",
      "size": 12345,
      "data": "data:image/jpeg;base64,/9j/4AAQSkZJRg..."
    }
  ]
}
```

The `attachments` array is empty when no files are selected. Files are read with `FileReader.readAsDataURL`; pending files are cleared after a valid n8n `output` response.

### Publishing

The browser submits multipart data to `POST /api/publish`. The server forwards `multipart/form-data` to the existing `N8N_WEBHOOK_URL`, adds `requestType=publish`, keeps all fields as form values, and streams the original uploaded media bytes as the `mediaFile` field.

| Field | Meaning |
| --- | --- |
| `requestType` | Added by server: `publish` |
| `postId` | Unique request ID |
| `currentType` | `0` text, `1` image, `2` video |
| `scheduleMode` | `now` or `scheduled` |
| `scheduledAt` | ISO 8601 timestamp; empty for immediate requests |
| `scheduleTimeZone` | Browser's IANA timezone |
| `title` | Optional internal title (empty in this composer) |
| `caption` | Caption followed by hashtags, separated by a blank line |
| `hashtags` | Hashtag text as a separate field |
| `platforms` | Selected lowercase platform names |
| `mediaFileName`, `mediaFileSize`, `mediaMimeType` | Original media metadata |
| `idempotencyKey` | Unique submission key |
| `mediaFile` | Original image/video binary, omitted for text-only posts |

The workflow should branch on `requestType`. The server does not report platform publication success unless the workflow itself returns such a result; a received webhook response alone is not treated as proof of publication.

## Local checks

Run `npm test` for registration, duplicate-email, login, protected-route, logout, CSRF/session, Google OAuth state validation, encrypted token storage, mocked Sheets setup, user-row isolation, and chat/multipart publishing compatibility checks. The tests mock Google APIs and stub the upstream n8n response; they do not verify live Cloud credentials, spreadsheet permissions, or webhook availability. Chat requests retain `chatInput`, `sessionId`, and attachments and are sent via POST to the configured chat webhook. Publishing retains its existing multipart format and separate `N8N_WEBHOOK_URL`.

## Current rollout limits

This project provides first-party email/password accounts, Google Sheets storage, and a server-side social OAuth/account persistence foundation. It does not include email verification or password reset. SQLite/WASM persistence is suitable for a single-process starter deployment; use a managed relational store and shared session service before running multiple server instances. The legacy `/api/publish` contract remains available alongside the new account-aware request route.

## Social account connections (integration status)

The **Connect Your Accounts** link opens `/connect-accounts`, which presents Facebook, Instagram, LinkedIn, TikTok, and YouTube connection cards plus administrator-only Google Sheets status. Social OAuth routes, encrypted token storage, account ownership, local disconnect/default selection, and account-aware publishing request tracking are implemented. Facebook Page text/image/video dispatch is implemented server-side behind the n8n shared-secret endpoint, but real provider authorization and publishing have not yet been verified.

Provider configuration, Facebook dispatch fields, status callback contract, persistence behavior, updated local n8n export, and remaining live-verification requirements are documented in [docs/social-accounts-integration.md](docs/social-accounts-integration.md). The export file must be imported/configured in n8n separately; editing the local export does not update the live n8n workflow. OAuth tokens are deliberately not forwarded to n8n.
