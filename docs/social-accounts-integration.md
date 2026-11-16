# Social accounts: implementation and setup

## Implemented in this project

- Social accounts are stored in the existing SQL.js SQLite database through the existing `AuthStore`. No second database or authentication system was added.
- OAuth authorization start and callback routes are implemented for Facebook, Instagram, LinkedIn, TikTok, and YouTube. OAuth state is random, session-bound, single-use, user-bound, and expires after ten minutes. Google/YouTube uses PKCE S256.
- Access and refresh tokens are encrypted with AES-256-GCM using `SOCIAL_TOKEN_ENCRYPTION_KEY`. Tokens and provider client secrets are not returned by account APIs or sent to n8n.
- Account listing, local disconnect, and per-platform default selection are scoped to the authenticated user.
- Publishing request and target records are stored in SQLite. A user-scoped idempotency key prevents a repeated account-aware request from being sent to n8n again.
- The account-aware publishing route verifies that every selected account is connected and belongs to the authenticated user before storing or forwarding the request.
- Facebook Page publishing is implemented behind a separate secret-authenticated n8n endpoint. It resolves the request/account pair in SQLite, decrypts the Page token only on the server, supports text, image, and video posts, and stores the returned Facebook post ID.
- A target dispatch lock prevents repeated n8n calls from creating a second post. Confirmed provider rejections may be retried explicitly (maximum three attempts); ambiguous timeouts are marked uncertain and are never blindly retried.
- The legacy `POST /api/publish` route and its multipart fields/media behavior remain unchanged.

Social provider flows and API permissions have not been verified against real provider applications. OAuth or publishing success must not be assumed until each provider app has been configured and a live test completed.

## Server configuration

Set these variables in the server-side `.env`; do not put credentials in frontend files:

- `SOCIAL_TOKEN_ENCRYPTION_KEY`: a unique 32-byte random key encoded as 64 hex characters. Keep it separate from the Google Sheets encryption key and back it up securely. Losing/changing it makes stored social tokens unreadable.
- Meta: `META_APP_ID`, `META_APP_SECRET`, `META_REDIRECT_URI`, and optionally `META_GRAPH_API_VERSION`.
- LinkedIn: `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`, `LINKEDIN_REDIRECT_URI`.
- TikTok: `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`, `TIKTOK_REDIRECT_URI`.
- YouTube: `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, `YOUTUBE_REDIRECT_URI`.
- `N8N_PUBLISHING_CALLBACK_SECRET`: at least 32 random characters. Configure the same value as an n8n HTTP Header Auth credential using header name `X-N8N-Callback-Secret`.
- `N8N_ACCOUNT_AWARE_PUBLISHING_ENABLED`: keep `false` until the updated workflow is imported, configured, and a real Page post is verified. Both account-aware submission and the Facebook dispatch endpoint return 503 while disabled.

Each provider redirect URI must exactly match its app configuration and point to `/api/social-accounts/oauth/callback` on the deployed ALISHA host. TikTok Login Kit Web requires a registered HTTPS redirect URI; a local plain-HTTP redirect may not be accepted. Do not guess or reuse the Google Sheets OAuth client for YouTube; YouTube has separate server-side client variables.

`META_GRAPH_API_VERSION` defaults to a code-defined value and is configurable so it can be advanced to a version supported by the Meta app. Provider permissions and products must be enabled/approved by each platform. Facebook requires a managed Page; Instagram requires an eligible professional account associated with a Page for this integration path; YouTube Data API must be enabled. Provider review, scopes, rate limits, and account eligibility can prevent authorization or publishing.

## Account API

Each connection click requests a fresh, uncached authorization URL with a new session-bound state. The accounts screen keeps the label `Connect Another Account` whenever that platform has connected accounts. It displays each account separately, and the existing post composer offers one checkbox per connected account. Reauthorizing the same provider identity updates that row without creating a duplicate; authorizing a different identity adds a separate row. Existing refresh tokens are retained when the provider omits a new refresh token during reauthorization.

Use ALISHA through the same origin as the configured callback URL (including ngrok hostname and port). The frontend sends its origin on OAuth start; the server reports a mismatch before sending the user to the provider, avoiding loss of the signed-in session on callback. API responses must be JSON and authorization URLs must point to the expected provider, so an HTML fallback or local callback URL cannot silently refresh the accounts page. Updated account scripts have a new cache version.

Google authorization requests `prompt=select_account consent`; TikTok requests `disable_auto_auth=1` and comma-separated scopes. TikTok token exchange/refresh accepts the documented top-level token response, and its user-info success envelope (`error.code=ok`) is treated as success. Meta authorization requests re-consent for previously declined permissions. These parameters start fresh provider authorization but cannot guarantee a different person is selected.

LinkedIn explicitly documents that an existing grant can bypass its consent screen and redirect immediately back to ALISHA. The app now reports when an existing identity was refreshed instead of claiming another account was added. To connect a different LinkedIn member, sign into that member on LinkedIn before clicking again (or use another browser profile and sign into ALISHA there). Similar provider-session selection applies to Facebook and its associated Instagram professional accounts. ALISHA does not sign users out of provider websites or revoke existing grants to force a chooser. See [LinkedIn authorization behavior](https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow), [Google account chooser](https://developers.google.com/identity/openid-connect/openid-connect), and [TikTok web authorization](https://developers.tiktok.com/doc/login-kit-web/).

Current discovery supports Facebook Pages, Instagram professional accounts linked to eligible Pages, LinkedIn member profiles, TikTok users, and YouTube channels returned for each authorized Google account. LinkedIn organization discovery and Instagram personal-account authorization are not implemented. Live provider consent, app review, permissions and account selection must still be verified using each configured developer app; automated tests use provider fixtures only.

All user-facing routes require the signed-in application session. State-changing routes also require the existing CSRF header.

| Route | Behavior |
| --- | --- |
| `GET /api/social-accounts` | Lists the authenticated user's accounts without token material. |
| `GET /api/social-accounts/:platform` | Lists only that user's accounts for the platform. |
| `GET /api/social-accounts/:platform/oauth/start` | Creates session-bound state and returns an authorization URL. The user is redirected by the frontend. |
| `GET /api/social-accounts/oauth/callback` | Validates and consumes the OAuth state, exchanges the code server-side, discovers eligible provider accounts, and stores encrypted tokens. |
| `POST /api/social-accounts/:id/disconnect` | Clears local credentials and marks only the caller-owned account disconnected. This does not guarantee that the user revoked the app grant at the provider; users may also revoke access in provider settings. |
| `POST /api/social-accounts/:id/set-default` | Sets a default only among the caller's connected accounts on the same platform. |
| `GET /api/publishing/requests` | Lists only the authenticated user's publishing requests and targets. |

The OAuth configuration keys, callback parameters, and stored token envelopes are server-only. API responses omit encrypted tokens and provider credentials. Provider IDs and profile metadata are not access tokens.

## Account-aware publishing contract

The existing composer loads the authenticated user's connected accounts. When accounts are available it submits multipart data to `POST /api/publishing/submit`; each selected account is sent in `socialAccountIds` as a JSON array. The server re-resolves every ID against the session user and requires connected status. Browser-provided `userId` is discarded.

The form preserves existing composer fields such as `postId`, `currentType`, `scheduleMode`, `scheduledAt`, `scheduleTimeZone`, `title`, `caption`, `hashtags`, `platforms`, media metadata, and `idempotencyKey`. Original media is sent as the `mediaFile` multipart field. The server adds `requestType=publish`, `publishingRequestId`, and an `accountTargets` JSON field containing internal account ID, platform, and provider account ID. OAuth tokens are not forwarded.

An idempotency key is unique per user in SQLite. Repeating a request with the same key returns the saved request instead of forwarding it a second time. A scheduled request is stored with `scheduled` status; an immediate request is stored as `processing`. A non-successful webhook response is tracked as `failed`. A successful webhook response is not treated as proof of platform publication.

For final per-target status updates, configure the n8n workflow to call `POST /api/internal/n8n/publishing-status` with header `X-N8N-Callback-Secret` equal to the server's `N8N_PUBLISHING_CALLBACK_SECRET`. The JSON body is:

```json
{
  "requestId": "the-publishingRequestId-returned-to-the-workflow",
  "status": "published",
  "targets": [
    {
      "accountId": "the-accountId-from-accountTargets",
      "status": "published",
      "platformPostId": "provider-post-id",
      "url": "provider-post-url",
      "publishedAt": "2026-01-01T12:00:00.000Z"
    }
  ]
}
```

The callback authenticates with the shared server-to-server secret and updates targets only under the stored publishing request. Do not send the callback secret from browser JavaScript. The current n8n export must be updated separately to consume `accountTargets` and post final status callbacks before these tracking transitions can occur. No n8n workflow was changed as part of this project implementation.

The existing `/api/publish` legacy route remains available and unchanged for the legacy flow. If no connected social accounts are available in the composer, it continues to use that route and original multipart contract.

## Persistence and deletion

The existing SQLite database gains `social_accounts`, `publishing_requests`, and `publishing_targets`, plus owner/status indexes and composite foreign keys. Existing user, session, and Google tables are left intact. User deletion cascades user-owned social accounts and publishing requests. Publishing target rows reference both the same user's request and social account. Disconnect marks the account disconnected and clears its encrypted token, while preserving account and publishing history.

Only OAuth provider credentials are encrypted at rest in SQLite. Captions, schedule fields, account identifiers, provider profile metadata, webhook HTTP status, and safe per-target result fields are stored as application data. Raw upload binaries are forwarded to n8n and are not stored in these SQLite tables. Passwords are not copied to provider records or n8n.

## Testing and remaining verification

OAuth failures now retain a redacted diagnostic for 15 minutes in the initiating signed-in session. `GET /api/social-accounts/oauth/diagnostic` exposes only that session's diagnostic: reference, platform, stage, provider HTTP status/error code and sanitized description. It does not expose authorization codes, state, credentials, access tokens, refresh tokens or raw provider bodies. A new authorization start clears the previous diagnostic. The callback URL carries only the diagnostic reference; provider descriptions are not put in the URL. The accounts screen displays the saved diagnostic, and server logs use the same reference for authorization start and failure. If no diagnostic is saved, stop the old Node process and restart this project before retrying; serving updated static JavaScript does not by itself reload Express route code.

`npm test` includes mocked OAuth/token exchange, state validation, token encryption, user isolation, idempotent forwarding, and status callback checks. These tests do not verify real provider consent, app review, live token refresh, account discovery, platform publishing, n8n execution, or production deployment. Live credentials are intentionally not part of the repository and must be configured by the developer.

The account-aware route is disabled by default and returns HTTP 503 until `N8N_ACCOUNT_AWARE_PUBLISHING_ENABLED=true`. It sends account IDs and platform identifiers, never user tokens, to n8n.

### Facebook backend dispatch

The n8n workflow calls `POST /api/internal/n8n/facebook-publish` once per selected Facebook Page target after its scheduling `Wait` resumes. It authenticates with `X-N8N-Callback-Secret` and sends multipart form fields `requestId`, `accountId`, and (for an image/video post) the original `mediaFile` binary. The backend joins the target to its stored request and account, verifies the target platform is Facebook and the account is still connected, and derives the owner from the stored request. It does not accept a browser user ID or a token in this call.

Text uses the Page feed edge; images and videos use the Page photos/videos edges. Caption text is loaded from the stored request. A successful response includes `requestId`, `accountId`, `status`, `postId`, optional `mediaId`, `permalink`, and `publishedAt`. The n8n workflow then calls the existing `POST /api/internal/n8n/publishing-status` endpoint with the same secret, using the returned post ID as that target's `platformPostId`/`postId`. The backend also stores the direct dispatch result so a lost callback does not cause a second publish.

The endpoint's dispatch record prevents duplicate calls. A repeated successful request returns the original result. A definitive Facebook rejection may be retried explicitly by n8n with `retry=true` (maximum three attempts). Network errors and server interruptions after dispatch begins are marked uncertain; n8n must not retry those automatically. Check the Page before manually retrying an uncertain post. Tokens are only used by the ALISHA server when calling Meta and are not returned to n8n.

### Importing the updated n8n export

The local `My workflow.json` export has had its three Facebook publishing nodes replaced with ALISHA backend calls, added per-Page fan-out, and added status callback calls. The deployed n8n workflow is not changed by editing this local export; import the reviewed export into n8n and configure the new HTTP Header Auth credential on the six new HTTP Request nodes. Set its header name to `X-N8N-Callback-Secret` and its value to the same server-side `N8N_PUBLISHING_CALLBACK_SECRET`. Replace `https://REPLACE_WITH_ALISHA_PUBLIC_HOST` in those nodes with the publicly reachable HTTPS origin for this ALISHA server. Do not use localhost when n8n is remote.

The workflow's scheduled path already waits before the Facebook publish branch. The new dispatch endpoint also rejects a request whose stored `scheduledAt` is still in the future. Verify that the n8n HTTP Request nodes preserve the incoming binary property `mediaFile0` for image/video branches. n8n execution and Facebook API behavior still require live validation.

### Facebook test sequence

1. Configure Meta app credentials and redirect URI on the server, ensure the Meta app has the required Page publishing permission approved for the intended test account, and connect the Facebook Page from ALISHA.
2. Import/configure the updated workflow and set the n8n host and header credential described above. Keep the flag disabled while configuring.
3. With a test Page and harmless test caption, temporarily set `N8N_ACCOUNT_AWARE_PUBLISHING_ENABLED=true`, restart ALISHA, submit one immediate text post, and verify the actual post on the Page and its returned post ID in ALISHA's publishing request record.
4. Repeat with a small image and video. Then test a scheduled post and confirm it is published only after the n8n Wait resumes.
5. Confirm n8n execution data and frontend responses contain no access token. Set the flag back to `false` until all tests succeed and you are ready to enable the feature.

Mocked tests do not verify Meta app review, real permissions, Page publishing, media acceptance, n8n import validity, production reachability, or live scheduling. No real Facebook post has been made by this implementation.
