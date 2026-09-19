# Temporary mobile diagnostics

## Enable and configure

The existing Next.js frontend captures diagnostics before hydration. The existing NestJS API handles authenticated `POST /api/v1/debug-report`, using the normal same-origin proxy. No new dependency, database migration, SMTP browser connection or AI call is involved.

Web build environment (`apps/web/.env.local` locally, or the web build process environment):

```dotenv
NEXT_PUBLIC_ENABLE_DEBUG_REPORT=true
NEXT_PUBLIC_APP_BUILD=your-commit-sha
```

API process environment (root `.env` in local development, or server environment):

```dotenv
ENABLE_DEBUG_REPORT=true
DEBUG_REPORT_EMAIL_API_KEY=your-resend-sending-key
DEBUG_REPORT_EMAIL_FROM=ShopMate Debug <debug@your-verified-domain.example>
```

Use a verified sender domain in Resend; the QQ address is the fixed recipient, not an assumed valid sender. Configure credentials yourself in the deployment secret environment, never commit them. API success means the email provider accepted the message, not proof it reached the inbox. Check spam/provider delivery status if absent. Provider docs: https://resend.com/docs/api-reference/emails/send-email

## Usage and privacy

On mobile/tablet, Report Error sits at bottom-right above the normal bottom controls, respecting safe area. It opens an optional description form with a notice; Send Debug Report sends one request. Native dialog overlays move the reporter into the active dialog so it stays reachable. Desktop fine-pointer viewports over 1024px hide it; collectors remain available when the debug flag is on.

Captured: last 60 runtime errors, unhandled rejections, console errors (original console still runs), failed/non-2xx fetch requests (URL/method/status/status text/duration), resource errors, CSP violations and storage access failures. Includes browser/device hints, UA, language, viewport, orientation, secure context, sanitized page URL/referrer, title, time zone, storage key names, public build/version/environment. Error records are capped at 700 characters; reports are trimmed below 60KB before sending. No Axios is used in this project.

Privacy deliberately limits capture: no headers, request bodies, storage values, raw response bodies, DOM snapshots, console objects or arbitrary rejection objects. Response bodies can contain customer data, so only response metadata is recorded. All query values and URL credentials/fragments are removed; common credential assignments, JWTs, key patterns, emails and long numeric identifiers are masked. Both client and server sanitize. Free-form error messages/descriptions can still contain names or other unrecognized personal information: do not enter personal data, limit access to the receiving mailbox, and delete reports after investigation. Do not treat regex redaction as a guarantee for arbitrary secrets embedded in prose.

## Authentication and limits

Existing global authentication guard applies: absent/expired cookies produce 401 and the user is told to sign in. This version intentionally cannot email reports before login. Cross-origin HTTP fetch failures cannot be definitively classified as CORS/TLS/DNS by browser JavaScript; reports include the visible error, URL scheme and secure-context hints, not an invented diagnosis.

Endpoint validates a strict schema, fixes the recipient to `1719379411@qq.com`, and limits each authenticated user to two attempts per minute (including provider failures). In-memory limiter is capped at 1000 active users. It is per API process and resets on restart; multi-process deployments need a shared limiter/proxy quota. The existing Express JSON parser provides a default pre-parse 100KB limit, followed by the report-specific 64KB validation. Provider calls have a 10-second timeout, do not auto-retry, and provider error bodies/secrets are never returned.

## Local testing

1. Build contracts: `pnpm --filter @shopmate/contracts build`.
2. Run targeted tests: `pnpm --filter @shopmate/web exec vitest run src/app/mobile-debug-script.test.ts`, `pnpm --filter @shopmate/api exec vitest run src/debug-report/debug-report.spec.ts`, and contracts `src/debug-report.spec.ts`. These mock email delivery and do not spend AI credits.
3. Enable frontend flag, start normal dev servers, sign in and use a 375px viewport. Trigger a test error or failed request with synthetic data. Open Report Error and send with a mock endpoint first.
4. For real email verification configure the API sender/key, submit one synthetic report, and check the QQ mailbox and provider delivery log. This sends an actual email.

## Deployment test and disable

Configure public flags during the **web build**, rebuild/restart web, then configure/restart the API. Visit from a real iPhone Safari and Android Chrome, sign in, reproduce, and submit. Test inside the AI modal as well as the dashboard. Check 401/429/offline paths and verify no token/cookie/response data in a synthetic report. Automated tests do not replace real-device Safari verification.

To disable immediately set API `ENABLE_DEBUG_REPORT=false` and restart API. Set `NEXT_PUBLIC_ENABLE_DEBUG_REPORT=false`, rebuild/redeploy web, and refresh open tabs; the script is then absent, with no interception or button. Existing tabs keep their installed collectors until reloaded. This feature is temporary and should remain disabled outside the diagnostic window.
