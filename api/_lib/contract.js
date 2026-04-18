// api/_lib/contract.js
// Shared contract helpers used by campaign-summary, and available to any
// future route that needs to reason about a contract's duration from the
// contacts.plan_type enum.
//
// IMPORTANT: the plan_type -> months mapping is also encoded in SQL at two
// sites (kept in-sync manually because Postgres can't share JS):
//   - migrations/2026-04-17-trigger-campaign-dates-on-active.sql
//   - migrations/2026-04-17-backfill-campaign-end.sql
// Both SQL files reference this module in a comment. If you add a new
// plan_type value, update all three sites.

// deriveContractMonths maps contacts.plan_type to a month count.
// "monthly" subscribers don't have a fixed end date, so we treat them
// as 12-month default for reporting purposes (the API caps at today anyway).
function deriveContractMonths(planType) {
  if (planType === 'quarterly') return 3;
  if (planType === 'annual') return 12;
  if (planType === 'monthly') return 12;
  return 12;
}

module.exports = { deriveContractMonths: deriveContractMonths };
