# Roles, workflows and design system

## Who does what (enforced on the server; the screens only hide what a role cannot do)

| Role | Starts on | Principal tasks | Can not |
|---|---|---|---|
| **Agent (RM)** | Today › My work | Call new enquiries (SLA clock shown), return missed calls, log outcome → next step, add family members and consent, create quotations, ask for a booking | See other agents' customers (leads, units' buyers, calls, chats, tasks, reports); approve discounts or bookings; cancel bookings; change payment totals |
| **Manager** | Today › My work / Team | Approve bookings and discounts, see unassigned / untouched / stalled / missed calls, workload, reassign with a reason, set payment schedules, void receipts (not their own) | Company settings and keys (platform support) |
| **Admin** | Today | Everything a manager does + team and roles (Settings › Roles & access), connector health | API keys (platform support) |
| **View only (founder)** | Today › Business | Booked / collected / quoted / estimated value with bases, recorded funnel, overall response SLA, cancellations, data freshness | Any change (router allow-list); buyer detail if the company switches *See buyers and payments* off |
| **Platform support (Developer)** | — | Opened from Super Admin, time-limited session; keys, integrations, recovery | Is never a sales user; every action audited |
| **Super admin** | /superadmin | Companies, plans, opening a support session | Reading company data outside a support session |

Configurable per company (Settings › Roles & access): new items *See buyers and payments on every unit*
(default on for Managers and View only, off for Agents) and *Cancel bookings and sales*.

## Organisation, reporting lines and scorecards

Admins set up to **five levels** (renamable; default Partner › Sales Head › Team Lead › Senior Sales Executive ›
Sales Executive) in Today › Team › Organisation, and place each person: level, who they report to, and — for a
Manager — whether they see **every lead** (default, as before) or **their team only** (their own leads, everyone
below them at any depth, and unassigned leads to hand out). Rules: you can only report to a more senior level, no
loops, nobody reports to themselves. Team scope is enforced on the server for leads, tasks, calls, chats, units'
buyers, the Team view, workload and reassignment (`server/modules/org.ts`, `server/core/scope.ts`).

**Scorecards** (`server/modules/scorecard.ts`), per calendar month, from recorded events only: new enquiries,
answered in time (overall), contacted, connected calls, visits done, quotations, bookings, booked value, collected
(receipts), customer touches.
- Agent: **Your month** on My work — each measure against their target.
- Manager / Admin: **Scorecard** on Team — the tree with each person's own figures or "with their team" totals;
  targets for anyone below them (Admins: anyone but themselves).
- Founder: the same tree, read-only, on Business.
Team totals add up everyone below a person; the in-time % is recomputed from the counts, never averaged.

## Comparisons and suggested next steps

Every scorecard figure shows the change from the previous month (▲/▼); the Business report shows each funnel step
and the response SLA for the same-length period before, judged the same way. Nothing is compared when the earlier
period has no data.

`server/modules/insights.ts` reads each customer's record and returns:
- a **readiness score** (0–100) — the sum of listed signals: furthest step reached, recent response, decision-maker
  and payer known, budget fits, minus overdue / no next step. Shown with its signals; it is an estimate from recorded
  facts, not a prediction.
- one **next step** with urgency (now / today / this week), the reason and the best time to contact (now if it is
  10:00–19:00 where they are, else their next local 11:00), then what follows. Rules in order: return a missed call, first contact, payment due, hold
  expiring, approval waiting, find the payer, confirm the visit, quotation, involve the family, invite to visit,
  re-engage, customer-care steps, overdue follow-up, set a next step.
- **risks**: going cold, abroad with no time zone, WhatsApp with no consent, budget below the unit's price.
Today ranks the agent's customers by urgency, then score. Suggestions never send anything; "Use this" only fills in
the next-step form. Scope is the same as for leads.

## Journey and gates

Enquiry → owner (assignment, by id) → **contact** (outcome + required next step) → people & consent → visit
(slot capacity reserved atomically; reschedule / cancel give the place back) → quotation (versioned; discount above
`quoteDiscountLimitPct` needs another person) → reservation (time-limited hold, `unitHoldHours`, default 48 h) →
**booking request** (gate: approved valid quotation + payer identified) → manager approval (atomic) → payment
schedule + receipts. Each step is recorded once as a milestone; reports read only recorded steps.

## Design system

Kept: Jost, navy ink `#0B2A44`, blue accent `#0B6BB0`, sage `#0E8A86`, rust `#B06A55`, warm page `#F4F0EB`, white
surfaces with `#D3E3F0` lines. Tokens are now named in `app/globals.css` (`--c-ink`, `--c-muted`, `--c-line`,
`--c-accent`, `--c-success`, `--c-warn`, `--c-danger`, radii, `--touch`, `--ease-out`).

Rules used by the new screens (Today, Journey):
- Lists, not card grids: one bordered list per queue, dense rows (name, why, when), late times in rust.
- One primary action per area; secondary actions are ghost buttons.
- Section titles are small caps labels; numbers are tabular.
- States: skeleton rows while loading, an empty line that says what "done" means, ErrorState with Retry, an offline
  notice that keeps the last data, inline warnings for partial failures and validation, a conflict reason from the
  server when a write lost a race.
- Accessibility: every control is a real button / input with a label; visible focus everywhere (`:focus-visible`);
  `aria-pressed` on choice chips; tablists with `role="tab"`; 44 px targets on touch screens; reduced motion honoured.
- Motion: none beyond skeleton pulse and the refresh spinner.

Not done: the older screens (Dashboard, Sales MIS, Reports, Inventory grid) were not restyled onto the tokens; the
Dashboard and YTD/MTD overlap with Today › Business and should be consolidated once the founders confirm the
Business view replaces them.
