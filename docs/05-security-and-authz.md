# 05 — Security, Authentication & Authorization

> Regulatory note: this document describes technical controls. It does **not** claim compliance with Egyptian law (e.g. Personal Data Protection Law No. 151/2020) or Egyptian Drug Authority rules; a legal review is required before production (see D-decisions in docs/01).

## Authentication
- Passwords: argon2id (library defaults), min 10 chars with letters+digits, common-password denylist. Unknown e-mail and wrong password return the **same** error and timing (dummy hash verification).
- Lockout: 5 consecutive failures → 15 min lock; recorded as `security_events`.
- Sessions: random 256-bit opaque token in an HttpOnly cookie; only its SHA-256 is stored. Idle timeout 30 min (sliding), absolute 12 h; revocation on logout, password change (other sessions), user suspension.
- MFA: RFC 6238 TOTP (verified against the RFC test vectors). `ADMIN_MFA_REQUIRED=true` blocks all `/admin` routes until the admin has MFA enabled *and* the session was MFA-verified. Secrets encrypted with AES-256-GCM (`DATA_ENCRYPTION_KEY`).
- Super admins are provisioned only via CLI (`create-admin.cli`), never via the public API.

## Authorization (server-side, every request)
Global `AuthGuard` (deny by default; `@Public()` opt-out) evaluates fresh database state per request:
1. Resolve session → user + **active** memberships (org type, verification, status).
2. CSRF check for state-changing requests (header must equal the session-bound HMAC token).
3. `@PlatformAdmin()` → `SUPER_ADMIN` (+MFA when required).
4. `@OrgAccess(permission, {orgType, requireVerified})` → caller must be an active member of `:orgId`; role must grant the permission; writes are blocked for suspended orgs; supply operations require a verified org; non-members get **404**.
5. Services additionally scope every query by organization (e.g. a PO is loaded only if the caller is its buyer **or** seller; inventory items only within `:orgId`). Defense in depth: a guard bug alone does not leak data.

### Permission matrix (`apps/api/src/common/auth/permissions.ts`)
| Permission | Owner | Manager | Staff | Viewer |
|---|:-:|:-:|:-:|:-:|
| org:read, inventory:read, supply:read | ✓ | ✓ | ✓ | ✓ |
| analytics:read | ✓ | ✓ | – | ✓ |
| inventory:write (add, count, sale, write-off, verify, batches) | ✓ | ✓ | ✓ | – |
| supply:receive, requests:respond | ✓ | ✓ | ✓ | – |
| org:update, inventory:import, inventory:price | ✓ | ✓ | – | – |
| supply:order (pharmacy), supply:fulfil + supply:discrepancy (warehouse), integrations:manage | ✓ | ✓ | – | – |
| members:manage | ✓ | – | – | – |

Patients have no org membership and therefore no access to organization or admin data; their own requests/alerts/notifications are scoped by session user id.

## Web & API hardening
| Threat | Control |
|---|---|
| CSRF | SameSite cookies + session-bound `X-CSRF-Token` + JSON-only mutations (HTML forms cannot send JSON cross-site) |
| XSS | React escaping (no `dangerouslySetInnerHTML`), strict CSP on web (`default-src 'self'`) and API (`default-src 'none'`), `nosniff`; inputs stored verbatim as data and tested with script payloads |
| SQL injection | 100 % parameterized SQL (`pg` placeholders); dynamic SQL only from internal column whitelists; tested with injection payloads |
| Brute force / abuse | per-IP rate limits (global/auth/finder), account lockout, bounded pagination, 1 MB body limit, query statement timeout (15 s) |
| Clickjacking | `frame-ancestors 'none'` + `X-Frame-Options: DENY` on API |
| Webhook spoofing/replay | HMAC-SHA256 signature over timestamp+raw body, 5-minute window, unique event ids |
| Secret leakage | secrets only from env; production refuses insecure defaults; logs redact cookies, auth, CSRF and signature headers; webhook secrets shown once and stored encrypted |
| Privilege escalation | fixed role matrix; last-owner protection; admins cannot change their own status; supply requires verified orgs |
| Data tampering | append-only ledger/audit/status history (DB triggers); audit written in the same transaction as the change |
| Enumeration | generic login errors; 404 for foreign org resources |

## Privacy
- Patients can search **without an account** and without GPS (city/district centroid).
- Geolocation is requested only on explicit click, used once, never stored; alert locations are rounded to ~110 m; search analytics keep only a ~1.1 km grid cell and no user id; IPs are stored as keyed HMAC hashes.
- Retention job: idempotency records 7 days, completed jobs 14 days, dead sessions 30 days, search events 365 days.

## Security assessment — residual risks
| Risk | Severity | Status / mitigation plan |
|---|---|---|
| No e-mail verification / password reset flow (no production e-mail provider yet) | Medium | Admin-assisted reset only; add provider + signed reset tokens before pilot |
| Rate limiter is in-memory per instance | Medium | Fine for single-node pilot; use Redis/PG-backed store when scaling horizontally |
| Pharmacy license/location verification is manual | Medium | Admin checklist; future: document upload + regulator registry check |
| `COOKIE_SAMESITE=none` mode (embedded preview) weakens one CSRF layer | Low | Token + JSON-only remain; production default is `lax` |
| Node 20 in build sandbox is EOL | Low | Containers use Node 22 LTS |
| No WAF / DDoS protection in front | Medium | Put a CDN/WAF (e.g. Cloudflare) in front of the web tier |
| Dependency vulnerabilities | — | `npm audit --omit=dev`: 0 after pinning patched `multer` 2.5.0 and scoped `js-yaml` 5.5.0 via `overrides` (2026-10-26) |

## Security checklist (pre-production)
- [ ] Unique `APP_SECRET`, `DATA_ENCRYPTION_KEY`, DB password from a secret manager; rotate on staff changes
- [ ] `NODE_ENV=production`, `COOKIE_SECURE=true`, `COOKIE_SAMESITE=lax`, `ADMIN_MFA_REQUIRED=true`, `SWAGGER_ENABLED=false`
- [ ] TLS everywhere (HSTS enabled by API helmet), DB not publicly reachable, least-privilege DB role (no superuser at runtime)
- [ ] `METRICS_TOKEN` set or metrics network-restricted
- [ ] Super admins provisioned via CLI and MFA enrolled
- [ ] Backups scheduled + restore drill performed (docs/09)
- [ ] `npm audit` clean in CI; base images patched
- [ ] Legal review: privacy notice, data processing, controlled-substance display policy, pharmacy liability terms
- [ ] Penetration test before public launch
