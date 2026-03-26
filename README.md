# Client HQ

Moonraker's client management platform. Proposals, checkout, onboarding, audits, and reporting - all on one domain.

## URL Structure

```
clients.moonraker.ai

/agreement                          → Read-only Client Service Agreement
/checkout/success                   → Post-payment redirect + status transition

/[slug]                             → Client router (prospect/onboarding/active)
/[slug]/proposal                    → Sales proposal
/[slug]/checkout                    → Stripe checkout (plan selection)
/[slug]/onboarding                  → Onboarding wizard (8 steps)
/[slug]/audits/diagnosis            → Audit diagnosis page
/[slug]/audits/action-plan          → Audit action plan page
/[slug]/audits/progress             → Audit progress tracker
/[slug]/reports                     → Monthly campaign reports
```

## Repo Structure

```
client-hq/
├── _templates/
│   ├── checkout.html
│   ├── onboarding.html
│   ├── proposal.html
│   ├── router.html
│   ├── diagnosis.html
│   ├── action-plan.html
│   ├── progress.html
│   └── report.html
├── agreement/index.html
├── checkout/success/index.html
├── [slug]/
│   ├── index.html              (router)
│   ├── proposal/index.html
│   ├── checkout/index.html
│   ├── onboarding/index.html
│   ├── audits/
│   │   ├── diagnosis/index.html
│   │   ├── action-plan/index.html
│   │   └── progress/index.html
│   └── reports/index.html
├── assets/
├── shared/
├── index.html
└── vercel.json
```

## Infrastructure

- **Domain:** clients.moonraker.ai
- **Hosting:** Vercel (auto-deploy on push to main)
- **Database:** Supabase
- **Payments:** Stripe
- **Repo:** Moonraker-AI/client-hq

## Projects

- **Audit & Reporting Assistant** - Manages audits, progress tracking, monthly reports
- **Sales Assistant** - Manages proposals (legacy, being consolidated)

Last updated: 2026-03-26
