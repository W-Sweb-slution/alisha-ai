# Render deployment: existing ALISHA installation

This guide transfers the existing SQLite file. It does not create a new user database, replace authentication, or change n8n webhook URLs/payloads. No Render service has been created or deployed by this change.

## Service configuration

Use `render.yaml` as a Blueprint, or enter these values when creating a **Node Web Service**, not a static site:

| Setting | Value |
| --- | --- |
| Repository/root directory | This existing project directory containing package.json |
| Runtime | Node.js 24.x, pinned in package.json |
| Build command | `npm ci --omit=dev` |
| Start command | `npm run start:render` |
| Health check | `/healthz` |
| Compute | Paid `1c-2g` (1 CPU / 2 GB) baseline; measure memory under actual upload load |
| Instances | Exactly 1; one Node process, no PM2 cluster or additional worker writing SQLite |
| Persistent disk | Mount `/var/data`, initial size 1 GB; increase as database/backups grow |
| Automatic deploys | Off during migration; Blueprint uses `autoDeployTrigger: 'off'` |

Render supplies `PORT`; don't copy the local `PORT=3000` setting. The app binds `0.0.0.0` and waits for SQLite initialization before listening. `/healthz` returns only readiness and creates no session; it does not call Google, n8n or social APIs.

The Blueprint initially starts in **maintenance mode**. Health returns `{"status":"maintenance"}` with HTTP 200 so the initial deployment can complete and you can access its disk through SSH. All other requests return 503. SQLite is not opened, so no empty application database is created. After import, disable maintenance; normal health returns `{"status":"ok"}` only when SQLite can be queried.

Render persistent disks require paid compute and survive service restarts and deploys. Disk-backed services cannot be scaled to multiple instances and do not have zero-downtime deploys. See [Render disk documentation](https://render.com/docs/disks), [Blueprint settings](https://render.com/docs/blueprint-spec), and [health checks](https://render.com/docs/health-checks).

## Environment variables

Enter values privately in Render's Environment settings. Never upload `.env` to GitHub or paste its contents into deployment logs. The Blueprint prompts for three secrets; enter all remaining integration variables below before leaving maintenance. Empty credentials do not become working integrations by deployment.

Fixed deployment settings:

```text
NODE_ENV=production
HOST=0.0.0.0
TRUST_PROXY=1
AUTH_DB_PATH=/var/data/alisha-auth.sqlite
AUTH_DB_REQUIRE_EXISTING=true
RENDER_MAINTENANCE_MODE=true
N8N_ACCOUNT_AWARE_PUBLISHING_ENABLED=false
```

Set `RENDER_MAINTENANCE_MODE=false` only after the database transfer is verified. Keep `AUTH_DB_REQUIRE_EXISTING=true` afterward: a missing file fails startup instead of silently creating an empty database. This guard also catches an unmounted disk or a mistyped database path when the file does not exist. The Blueprint attaches the disk at the exact path used by the database.

Copy the **existing values**, without surrounding .env quote characters, for:

| Variables | Purpose |
| --- | --- |
| `SESSION_SECRET` | Preserve the existing session-signing secret |
| `SOCIAL_TOKEN_ENCRYPTION_KEY` | Preserve the exact key required to decrypt existing social tokens |
| `GOOGLE_TOKEN_ENCRYPTION_KEY` | Preserve the exact key required to decrypt central Google tokens |
| `ALISA_CHAT_WEBHOOK`, `N8N_WEBHOOK_URL` | Preserve the current chat and publishing destinations exactly |
| `N8N_ENVIRONMENT` | Preserve the current setting; setting a label to production does not turn a test URL into a production URL |
| `N8N_PUBLISHING_CALLBACK_SECRET` | Preserve the existing n8n dispatch/status shared secret if configured |
| `ALISHA_ADMIN_EMAIL` | Existing developer account email; do not assign a different user implicitly |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_SPREADSHEET_ID` | Existing central Google Sheets configuration |
| `META_APP_ID`, `META_APP_SECRET`, `META_GRAPH_API_VERSION` | Existing shared Facebook/Instagram Meta app; version remains configurable |
| `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET` | Existing LinkedIn app |
| `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET` | Existing TikTok app, if configured |
| `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET` | YouTube OAuth client, separate from the central Sheets connection |

Do **not** generate replacement encryption keys when moving the database. The database stores encrypted tokens, not the keys. Back up the keys separately in a password manager. Losing them prevents token decryption. Keep the existing session secret stable across later deploys as well.

After Render assigns the service URL, use that actual HTTPS origin as `O` below (do not enter the letter O literally):

| Variable | Exact URL pattern |
| --- | --- |
| `GOOGLE_REDIRECT_URI` | `O/api/google/callback` |
| `META_REDIRECT_URI` | `O/api/social-accounts/oauth/callback` |
| `LINKEDIN_REDIRECT_URI` | `O/api/social-accounts/oauth/callback` |
| `TIKTOK_REDIRECT_URI` | `O/api/social-accounts/oauth/callback` |
| `YOUTUBE_REDIRECT_URI` | `O/api/social-accounts/oauth/callback` |

For example, replace O with the actual `https://<assigned-service>.onrender.com` URL shown in Render. Register the exact full URLs with the existing provider apps. Facebook and Instagram share `META_REDIRECT_URI`; Google Sheets and YouTube have different callback paths/configuration. Keep previous localhost/ngrok callback entries during transition if the provider supports multiple registered entries. Sign into ALISHA and start OAuth on the same permanent origin so session cookies follow the callback. Existing valid tokens remain in SQLite; moving them does not itself require reconnection, although a provider may revoke or expire a token independently.

If n8n's account-aware backend dispatch nodes are configured later, their ALISHA destination URLs must use the permanent origin for `/api/internal/n8n/facebook-publish` and `/api/internal/n8n/publishing-status`. Keep the same shared secret in its private n8n credential. The n8n workflow's own webhook URLs are unchanged. The feature flag remains disabled until the separately authorized live publishing tests pass.

## Transfer the existing database without losing users

1. Locate the actual SQLite file using your current `AUTH_DB_PATH`; the default is `data/alisha-auth.sqlite`. The database includes users/password hashes, persistent sessions, central Google encrypted tokens, social accounts/encrypted tokens, and publishing request/target records. Do not export only the users table.
2. Stop the local ALISHA process with Ctrl+C and let active requests finish. Do not run two SQL.js processes against the same database. Avoid cutover while requests are publishing. Keep the local service stopped after the final snapshot to avoid two diverging installations.
3. Make a private backup copy of the stopped database outside the Git repository. Keep the original untouched. On Windows, use `Copy-Item -LiteralPath '<actual database path>' -Destination '<private backup path>'`. Record `Get-FileHash -LiteralPath '<backup path>' -Algorithm SHA256`. Keep `.env`/keys backed up separately and privately; never send them through Git.
4. Publish only the application source to your repository after checking exclusions. `.gitignore` excludes environment files (except the blank .env.example), databases, keys, logs, generated outputs, and working artifacts. Ignore rules do not untrack files committed in the past: inspect `git ls-files` before pushing. If a secret was previously published, removing the file from the latest commit does not remove it from Git history; handle that separately before using the repository.
5. Create the Render service with the disk and **maintenance enabled**. Set the environment variables above. Do not run database initialization in a build or pre-deploy command; Render disks are available to the running service, not its build environment.
6. After the first maintenance deployment succeeds, use the service's Shell/SSH connection from Render. Transfer the snapshot privately to a unique staging filename under `/var/data`. Use the actual SSH destination supplied by Render, for example:

   ```text
   scp -s "<private-local-snapshot.sqlite>" <Render-SSH-destination>:/var/data/incoming-unique.sqlite
   ```

   The destination is a staging filename, not the active `alisha-auth.sqlite`. Compare its `sha256sum /var/data/incoming-unique.sqlite` with the local hash. See [Render file transfer instructions](https://render.com/docs/disks#transferring-files).

7. In the Render Shell, with maintenance still enabled, run:

   ```sh
   npm run db:install -- /var/data/incoming-unique.sqlite /var/data/alisha-auth.sqlite
   ```

   This validates SQLite integrity, checks required authentication tables and foreign keys, writes a synced copy, and refuses to overwrite an existing destination. On Render/Linux it installs using an atomic no-overwrite hard link. It preserves the source. If the destination already exists, **stop and investigate**; do not delete it or force a replacement. On Windows the helper uses exclusive copying because sandboxed hard links may be unavailable; always keep the application stopped during import.

8. Confirm the correct disk is mounted, the database exists, and the original secrets are configured. Set `RENDER_MAINTENANCE_MODE=false`, keep `AUTH_DB_REQUIRE_EXISTING=true`, then manually deploy/restart. The app loads the transferred database and runs only its existing additive schema initialization. It never resets tables. Do not re-run the import on every deploy.
9. Check `/healthz` returns `{"status":"ok"}`, then sign in using an existing account. Verify account names/defaults and the central Google status. Verify logout/login, chat and attachments with non-sensitive content. Only test publishing when separately approved. Perform a subsequent restart/deploy and confirm existing users/accounts remain available.

If cutover fails, re-enable maintenance and retain both databases/backups for diagnosis. A code rollback is separate from restoring data; this preparation adds no destructive schema migration. Do not overwrite the new live database with an older local file after users have started writing to Render.

## Sessions, history, uploads and shutdown

- SQL.js exports the entire in-memory database after writes. Saves fsync the temporary file, atomically rename it and fsync the containing directory on Linux. Use one process on one instance. A persistent disk does not make this architecture safe for multiple writers or eliminate the need for backups.
- Sessions remain in SQLite with their existing expiry. Production cookies remain HttpOnly, Secure and SameSite=Lax; `TRUST_PROXY=1` makes Render's HTTPS termination visible to Express. Switching from localhost/ngrok to Render requires a new browser login because cookies belong to a hostname. Existing passwords and accounts remain valid.
- Browser-local conversation history belongs to the old origin too. It does not automatically move to Render. Existing Google Sheets conversation records remain in the same central spreadsheet, but the current UI does not automatically rebuild its local history from Sheets. This change does not add a new history-import feature.
- Multipart media uses Multer memory storage with the existing 200 MB file limit. JSON/Base64 chat attachments retain the existing 250 MB JSON limit. No binaries are stored in SQLite or on Render's ephemeral filesystem; original files go to n8n. Large/concurrent uploads consume RAM, so the 2 GB plan is a starting point, not a capacity guarantee. Proxy limits, real media sizes and memory use need a live smoke test. The Node/argon2 build must also be verified on Render's Linux runtime.
- Scheduled media retention and Wait-node recovery remain responsibilities of the existing n8n deployment. A Render disk does not make n8n's binary storage persistent. n8n remains external; no workflow is changed here.
- SIGTERM/SIGINT stop new connections, allow up to 25 seconds to drain active requests, and close SQLite after a final flush. Upstream requests can take longer, so avoid planned deploys during uploads/publishing. An interrupted account-aware publish stays subject to the existing uncertain-outcome/duplicate protection; do not blindly resubmit legacy requests after an interrupted connection.
- Maintain private, regular backups from a stopped/safe snapshot of the database. A disk snapshot is not a substitute for a tested application backup and the original encryption keys.

## Local compatibility and verification limits

`npm start` continues to run the existing application with local `.env`, port 3000 by default, SQLite under `data/`, and non-Secure cookies for local HTTP. Set `AUTH_DB_REQUIRE_EXISTING=false` locally if you intentionally want a fresh local install. Only `npm run start:render` uses the maintenance switch. No actual .env values or existing database files were edited by this deployment preparation.

Automated tests use disposable databases and mocked integrations. They check production proxy/cookie behavior, public health, 0.0.0.0 binding, persistence after reopen, encrypted accounts, missing-file refusal, no-overwrite import, and maintenance without database writes. They do not prove live Render disk persistence, Linux fsync/hard-link behavior, real OAuth approval, n8n reachability, or real social publishing. Complete the deployment smoke checks before calling the deployment verified.
