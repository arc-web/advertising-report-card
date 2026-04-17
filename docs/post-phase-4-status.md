# Post-Phase-4 Status Report

**Date:** 2026-04-17 (late session — Group A fully complete)
**Purpose:** Reconcile what's actually closed, group the ~87 remaining findings, and recommend a path forward that matches the value-per-session curve we've been on.

---

## Where the audit stands

All 9 Criticals closed. **Eleven Highs closed** (H5, H7, H8, H9, H10, H11, H14, H28, H33, H34, H35). M8, M13, M38 closed; M26 err-leak half closed, prompt-injection half deferred to Group D. **L8**, L14, L26, L27 closed. H21 has scaffolding landed (`api/_lib/google-delegated.js`) but 5 duplicate sites still need migration. `authenticator_secret_key` null-on-all-rows investigation resolved: `SENSITIVE_FIELDS` includes it; the null state just means no 2FA setup has been saved yet through the admin UI. Not a bug.

~87 findings remain. None of them are attack chains of the same severity as C1-C9. Most are hardening, consistency, and observability work. Ordering them linearly doesn't match their actual value; grouping them does.

---

## Grouping of remaining work

### Group A — Secret & config hygiene ✅ COMPLETE

| ID | Issue | Status |
|---|---|---|
| H10 | `api/admin/manage-site.js:15,18` — hardcoded CF account/zone IDs | ✅ closed `e772fa9` |
| H7 | `api/_lib/supabase.js:15` — hardcoded Supabase URL fallback | ✅ closed `330e6da` |
| H28 | `bootstrap-access.js` leaks provider error detail in response body | ✅ closed `0c9bc85` |
| H33 | `newsletter-generate.js` raw Claude output in error responses | ✅ closed `a8155dc` |
| H34 | `send-audit-email.js` Resend response + err.message in 5xx | ✅ closed `225d5a0` + `19b9199` |
| H35 | `generate-content-page.js` NDJSON stream error detail leaks | ✅ closed `b17c790` |
| M13 | `newsletter-webhook.js` e.message in response body | ✅ closed `3a9019d` |
| M26 (err-leak half) | `chat.js` err.message in outer catch | ✅ closed `9dc8c7b` (prompt-injection half → Group D) |
| L15 | Onboarding template anon key exp 2089 | Design question (deferred) |

**Group A done.** 8 findings closed (6 Highs + 1 Medium + 1 Medium-partial). Pattern established: `monitor.logError(route, err, { client_slug, detail: { stage, ... } })` server-side + generic user-facing response. Replicated cleanly across 6 files in two sessions.

### Group B — Shared library extraction (2-3 sessions, mechanical)

| ID | Issue | Status |
|---|---|---|
| H21 + N6 | 7 copies of `getDelegatedToken` → extract `_lib/google-auth.js` with caching | 🔶 helper landed in `7adedb6` (`api/_lib/google-delegated.js` with token caching); 5 duplicate sites still pending migration |
| H4, H24, M10, M16 | `fetch()` without AbortController — extract `fetchWithTimeout` helper | 1 session |
| Pattern 12 | Migrate ~30 inline Supabase fetches in 5 big files to `sb.query`/`sb.mutate` | 1-2 sessions |
| H30, L7, L8, L22 | Duplicated helpers (Fathom dedup, Resend events, sbGet) | L8 ✅ closed; rest open |

**Recommendation:** H21 migration session is cheaper than originally scoped — the helper is already live in `api/_lib/google-delegated.js` with working token caching. Migration reduces to: delete 5 local copies, add require, rename call sites. Then AbortController. Then the Supabase helper migration.

### Group C — Template/email escape defaults (1 session, template surface)

| ID | Issue | Effort |
|---|---|---|
| H18 | Newsletter story fields rendered unescaped | In one session |
| H19 | Image URL not scheme-validated | Same session |
| H20 | `p()` + `footerNote` accept raw HTML | Same session |
| H22 | Proposal `next_steps` rendered unescaped | Same session |
| M6 | Monitor alert HTML unescaped | Same session |
| M22 | Unsub subscriberId not URL-encoded | Trivial |

**Recommendation:** One session. Goal: make the default behavior of every template helper "escape input," add `.raw()` variants for the rare case when the caller actually has HTML. This pattern lands across all template modules at once.

### Group D — AI prompt injection hardening (1 session)

| ID | Issue | Effort |
|---|---|---|
| H25 | `practiceName` raw-interpolated into Claude prompt (compile-report) | Included |
| H31 | 25K chars of RTPBA to Claude verbatim (generate-content-page) | Included |
| M15 | Therapist name unsanitized in content-chat prompt | Included |
| M26 | `page`, `tab`, `clientSlug` in chat.js prompt | Included |

**Recommendation:** One session. Standardize the "untrusted input in Claude prompt" pattern: structured delimiters (`<user_data>` tags), the same kind of treatment C9's endorsement sanitization gave but applied consistently everywhere user input reaches a prompt.

### Group E — Non-transactional state & idempotency (1 session)

| ID | Issue | Effort |
|---|---|---|
| H26 | onboarding seed DELETE+INSERT non-transactional | One session |
| H27 | compile-report highlights DELETE+INSERT non-transactional | Included |
| M11 | deploy-to-r2 DELETE+INSERT not idempotent | Included |
| M30 | generate-proposal fire-and-forget PATCHes swallow errors | Included |

**Recommendation:** One session. All four are the same class of bug — crash between DELETE and INSERT leaves zero rows. Standard fix is upsert or wrap in RPC. Pattern is clear; applying it takes an hour.

### Group F — Public endpoint hardening beyond rate limits (1 session)

| ID | Issue | Effort |
|---|---|---|
| H15 | submit-entity-audit empty-Origin bypass | One session |
| H32 | digest.js recipients from request body, no allowlist | Included |
| M9 | submit-entity-audit slug race condition | Included |
| M12 | manage-site domain "normalization" too permissive | Included |
| M14 | content-chat silently returns nulls on Supabase error | Included |
| M20 | newsletter-unsubscribe UUID-probing oracle | Included |

**Recommendation:** One session. All input-validation/boundary-check fixes on public-ish endpoints.

### Group G — Operational resilience (1 session)

| ID | Issue | Effort |
|---|---|---|
| H1 | `_profileCache` no TTL | 15 min |
| H2 | Still listed as open — but H2 is just "same bug in two files" and the helper is extracted; verify and close | 5 min |
| H3 | `rawToDer` dead code — delete | 5 min |
| H6 | Stripe webhook fire-and-forget to `/api/notify-team` with no retry | 30 min (queue table or inline) |
| H13 | Agreement-chat 8K CSA on every prompt — add Anthropic prompt caching | 30 min |
| H17 | process-entity-audit internal auth fallback empty-string | 15 min |
| H29 | enrich-proposal encrypt `enrichment_data` at rest | 30 min |
| M2 | `last_login_at` updated every request — throttle | 15 min |
| M18 | checklist_items composite ID 8-hex-char collision | 10 min |
| M19 | Webhook race with auto-send audit email | Needs design |

**Recommendation:** Two short sessions, cherry-pick the 15-30 min items into groups of 4-5.

### Group H — M1 Stripe metadata detection (0.5 session)

Documented plan in M1 section. Blocked on you adding `metadata: { product: ... }` to the Stripe payment links dashboard-side. After that's done, code change is 10 minutes + a 30-day observation window before removing the amount fallback.

### Group I — Lows + Nits (1 sweep session)

25 Lows + 6 Nits still listed; several are likely stale after Phase 4. Worth a 1-session sweep: reconcile what's actually still present vs what got closed incidentally, then fix the remaining in-scope items (≤10 lines each).

---

## What's **not** in the groupings

Items I recommend marking "won't fix" or "needs design":

- **L3** (`var` everywhere): cosmetic. Skip.
- **L13** (hardcoded asset URLs): single-domain app. Skip.
- **L15** (anon key exp 2089): RLS is the control. Either leave as-is (accept the risk profile) or plan a migration — not both half-measures.
- **L16** (two Google auth functions in compile-report.js): closes with H21.
- **L19** (personal-email blocklist): add as data, not a code change.
- **M19** (webhook race with auto-send): needs a design — what's the desired behavior when Stripe lands after the free tier email already sent? Hold and refund? Upgrade anyway? Product decision, not a code decision.
- **M37** (auto-schedule doesn't check post-submit status flip): same — is this a bug or intended?

---

## Recommended next session

**Group A pattern fix — H33 + H34 + H35 + M13 + M26 (err-leak half).**

Reasoning:
- Closes Group A completely. Symmetrical finish to the small-wins work.
- All five are the same shape: response bodies (and one NDJSON stream) leak `err.message`, Anthropic/Resend response bodies, or raw AI output on the 5xx path. Same fix pattern everywhere: route detail to `monitor.logError` server-side, return generic messages to caller.
- H28 (just shipped) is the reference pattern — `monitor.logError(route, err, { detail: {...} })` + sanitized response. Clean mental model for the session.
- One session, 5 files, ~5 commits.

After that, the recommended sequence is:

1. **Group A pattern fix — err.message leaks** (1 session) — H33, H34, H35, M13, M26
2. **Group B.1 — H21 google-auth migration** (1 session) — helper already live, 5 duplicate sites to replace
3. **Group C — template escape defaults** (1 session) — fixes 6 related findings in one pass
4. **Group B.2 — AbortController extraction** (1 session)
5. **Group D — AI prompt injection hardening** (1 session)
6. **Group E — non-transactional state** (1 session)
7. **Group B.3 — Supabase helper migration** (1-2 sessions)
8. **Group F — public endpoint hardening** (1 session)
9. **Group G — operational resilience batched small items** (1-2 sessions)
10. **Group I — Lows + Nits sweep** (1 session)
11. **Group H — M1 Stripe metadata** (once dashboard metadata is added)

Approximately 10-12 sessions to clear the remaining open findings, or we stop earlier once diminishing returns kick in.

---

## Prompt for next session (Group C — template escape defaults)

```
Template escape defaults session. Six findings in one pass, across three
template modules and ~10 caller files. Pattern: make the default helper
names (`p`, `footerNote`, body inserters) escape by default, add explicit
`.raw` variants for the HTML-building cases that exist today, don't break
any existing caller on the way through.

Read docs/api-audit-2026-04.md sections H18, H19, H20, H22, M6, M22
first. Then walk through your plan before touching code.

Reference pattern for the overall approach: two-part rollout in a single
atomic commit per module.
  Step A: rename current raw helpers to explicit `.raw` names
  Step B: add new safe defaults that escape
  Step C: migrate every existing caller to the `.raw` variant so behavior
          is byte-for-byte preserved. Future sessions can opportunistically
          upgrade plain-text callers to the new safe defaults.

─────────────────────────────────────────────────────────────────────
Fix 1: H18 + H19 + M22 — api/_lib/newsletter-template.js (single commit)
─────────────────────────────────────────────────────────────────────

Current state (pre-verified on main):

  Line 14:  esc(s) helper already exists — reuse, don't duplicate.
  Line 160: `UNSUBSCRIBE_BASE + (subscriberId ? '?sid=' + subscriberId : '')`
            → M22: wrap subscriberId with encodeURIComponent()

H18 sites (unescaped interpolation of potentially-untrusted fields):
  Line 54   `+ item +`               in storyBlock actionHtml (array map)   → esc
  Line 55   `+ items +`              in storyBlock actionHtml (string case) → esc
  Line 58   `+ item +`               in storyBlock actionHtml (array case)  → esc
  Line 66   `(story.headline || '')`                                        → esc
  Line 83   `+ item +`               in quickWinsBlock                      → esc
  Line 103  `spotlight.cta_text`                                            → esc
  Line 108  `+ headline +`           spotlight headline var                 → esc

KEEP RAW (these are AI-generated HTML by design, not plain text):
  Line 68   `(story.body || '')`      — AI generates <p> tags
  Line 102  `(spotlight.body || '')`  — AI generates HTML
  Line 120  `+ text +`                in finalThoughtsBlock — AI-generated HTML

If you feel strongly the design is wrong (AI shouldn't generate HTML, should
generate markdown-like markers we render), flag it for Chris but don't
change it this session. Scope fence.

H19 sites (image_url scheme validation):
  Line 41   `<img src="' + esc(story.image_url) + '"` — esc() prevents HTML
            injection but `javascript:`, `data:`, and `file:` URLs still
            escape cleanly and remain clickable in some email clients.

  Fix: add a `validateImageUrl(url)` helper near esc() that returns `url`
  only if it starts with `https://` or `http://`, else returns '' (safe
  fallback — no image rendered). Apply at line 41 wrapping image_url.
  Check for any other image src sites (grep `<img `) to be thorough.

─────────────────────────────────────────────────────────────────────
Fix 2: H20 — api/_lib/email-template.js + 9 caller files (atomic commit)
─────────────────────────────────────────────────────────────────────

Context:
- Function `p(text)` at L48 returns raw HTML wrapping `text` in <p>. Called
  ~82 times across 9 files. The majority of calls concat literal HTML
  (`<strong>`, `&bull;`, `email.esc(var)`) so they need the raw behavior.
- Field `footerNote` is an *option* to wrap() (not a function), inserted
  raw at L164. Called in 8 files. One of them (send-proposal-email.js)
  passes HTML with an `<a>` tag + styles; the others pass plain strings.

Plan (single atomic commit):

  email-template.js changes:
    1. Rename internal `function p` → `function pRaw`.
    2. Add new `function p(text)` that returns
       `'<p style="..."">' + esc(text) + '</p>'`
    3. Export both: `p: p` (new safe), `pRaw: pRaw` (current behavior).
    4. In `wrap()`: support both `options.footerNote` (new, esc-wrapped)
       and `options.footerNoteRaw` (current behavior). If both present,
       `footerNoteRaw` wins. If only `footerNote`, esc-wrap it.

  Caller changes (9 files):
    api/compile-report.js
    api/digest.js
    api/generate-audit-followups.js
    api/generate-followups.js
    api/ingest-batch-audit.js
    api/ingest-surge-content.js
    api/notify-team.js
    api/send-audit-email.js
    api/send-followup-email.js (check — currently 0 p calls but may have
                                 module-level usage)
    api/send-proposal-email.js
    api/send-report-email.js
    api/generate-proposal.js (only if it uses email.p; verify — H22 touches it anyway)

    Mechanical change: sed-replace every `email.p(` → `email.pRaw(`.
    Behavior preserved exactly (renamed-original).

    footerNote: only send-proposal-email.js passes HTML — change to
    `footerNoteRaw:` there. Other 7 callers pass plain strings (including
    'This is an internal notification for the Moonraker team.' and '') —
    safe to leave on the new `footerNote` option since escape of plain
    text is a no-op on content that has no HTML metacharacters. (If any
    plain-text caller contains `&`, `<`, `>`, `"` — an apostrophe is fine
    — they also need `footerNoteRaw`. Grep to check.)

Result: 100% byte-identical email output. New safe `p()` and `footerNote`
now exist for future callers. H20 closed.

─────────────────────────────────────────────────────────────────────
Fix 3: H22 — api/generate-proposal.js (single commit)
─────────────────────────────────────────────────────────────────────

Two sites at current line numbers:

Line 331: `(customPricing.amount_cents / 100).toLocaleString()`
  If `amount_cents` is undefined/null/non-numeric, this produces '$NaN'
  in the deployed proposal. Guard:
    var amt = Number(customPricing.amount_cents);
    if (!Number.isFinite(amt) || amt < 0) { /* skip card or log error */ }
    else investmentCardsHtml += '<div>$' + (amt/100).toLocaleString() + '</div>';

Line 332: `(customPricing.label || customPricing.period)` — admin-controlled
  string, flows into deployed HTML. Escape via local esc helper (reuse the
  function already defined in the file if present, else define inline:
  same shape as newsletter/email-template esc()).

Line 361: `(s.title || 'Step ' + (i+1))` + `(s.desc || s.description || '')`
  next_steps from AI, flows into deployed HTML. Escape both.

Note: this file generates HTML that gets pushed to GitHub → deployed to
live domain via Vercel, not email. Don't import email-template.js. Define
or reuse a local `esc()` helper.

─────────────────────────────────────────────────────────────────────
Fix 4: M6 — api/_lib/monitor.js (trivial, bundle with doc update)
─────────────────────────────────────────────────────────────────────

Line 83: `'<p><strong>Route:</strong> ' + route + '</p>'`  → wrap route with escHtml()
Line 85: `'<p><strong>Client:</strong> ' + slug + '</p>'`  → wrap slug with escHtml()

Note: Line 81's subject also uses `route` and `slug` unescaped, but
subject is plain text (not HTML) so it's not an HTML injection vector.
Optional: strip newlines from subject anyway to prevent header injection.
Not flagged by M6 — your call.

`escHtml()` already exists at L104. Reuse it.

─────────────────────────────────────────────────────────────────────
Testing
─────────────────────────────────────────────────────────────────────

- Each commit's Vercel deploy must go READY.
- For Fix 1 (newsletter-template): there's no easy preview harness, but
  the existing `/admin/newsletter` preview flow exercises storyBlock +
  spotlight + finalThoughts. Visually inspect a preview for an existing
  newsletter after the commit. Expect zero diff since the fields being
  escaped haven't historically contained HTML metacharacters.
- For Fix 2 (email-template): more critical. Hit `/api/test-email` or
  equivalent, or just let the next transactional email (say, a proposal
  send) exercise it. Byte-identical HTML expected.
- For Fix 3: spot-check /_templates/proposal.html rendering in an existing
  deployed proposal (via clients.moonraker.ai/<slug>/proposal). If `esc`
  breaks anything, the symptom is literal `<strong>` or similar appearing
  in the next_steps section.
- For Fix 4: trigger a critical error (monitor.critical call) if you
  have a dev path for it; otherwise, a grep-verify is fine.

─────────────────────────────────────────────────────────────────────
Out of scope
─────────────────────────────────────────────────────────────────────

- Migrating individual `email.pRaw(` callers back to the new safe `email.p(`
  (opportunistic future cleanup).
- Changing the AI generation prompt to emit plain text instead of HTML for
  story.body / spotlight.body / final_thoughts (design change, not scope).
- H25, H31, M15, M26-prompt-half (Group D — AI prompt injection).
- Any rate limiting on email-related routes (Group F).

─────────────────────────────────────────────────────────────────────
Deliverables
─────────────────────────────────────────────────────────────────────

Commit shape (suggested — combine/split as you prefer):

  c1: H18 + H19 + M22 — newsletter-template: escape untrusted fields,
      validate image URL scheme, encode subscriberId
  c2: H20 — email-template rename + caller migration (atomic; ~10 files)
  c3: H22 — generate-proposal: amount_cents guard + escape label + escape
      next_steps items
  c4: M6 — monitor critical alert: escape route + slug

Final: doc update — mark H18, H19, H20, H22, M6, M22 resolved in
docs/api-audit-2026-04.md resolution log. Update running tallies:
  High 11 → 15 resolved (H18, H19, H20, H22)
  Medium 3+ → 5+ resolved (M6, M22)

Also update docs/post-phase-4-status.md: mark Group C complete, note the
opportunistic `pRaw` → `p` migration as follow-up work.
```

## Closing thought on the grouping approach

The original phase-based plan (phases 1-7) was right when the audit was fresh and we needed to prioritize Criticals. Now that Criticals are all closed, continuing phase-by-phase would force awkward sequencing — e.g. doing H9 in "Phase 5" and H18 in "Phase 7" even though they're unrelated.

Grouping by shape (what kind of fix, what files, what skill) means each session has a single theme, one mental model, one commit style. That's a better fit for the current phase of work.
