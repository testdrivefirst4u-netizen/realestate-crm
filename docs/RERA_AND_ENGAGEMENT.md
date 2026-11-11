# RERA payment schedules and customer engagement

Amaya Phase 1 is in Medchal, Hyderabad, so the Telangana rules apply. Sources and what still needs counsel are at the end.

## RERA payment schedule (`server/modules/rera.ts`, receipts in `server/modules/payments.ts`)

| Rule | How the CRM follows it |
|---|---|
| **Advance cap — RERA Act s. 13**: at most 10 % of the cost before a registered agreement for sale | A plan cannot put more than 10 % on "booking"; demands and receipts before *Record registration* are refused beyond 10 %, with the reason |
| **Agreement in the TG-RERA format** (Telangana Rules 2017, Rule 38 / Annexure A), as filed at registration, with its payment plan | Plans are entered by a manager from the registered agreement and must name it (`agreementRef`); units get their schedule from a plan. A hand-built schedule is a **deviation**: reason required, marked (Amaya SOP 14: MD approval) |
| **Instalments by construction stage** | Instalments are due on booking, on registered agreement, on certification of a construction stage, or on possession. Certifying a stage (with the architect / engineer certificate reference) raises the demand on every booked unit that waits on it — once |
| **Demand letters** | Generated for each demand (number, payee, unit, TG-RERA number, instalment, GST, total, due date) for review and printing. **The CRM never sends them** |
| **Interest for delay — same rate both ways** (Act s. 2(za)); SBI rate + 2 % under the Telangana Rules | A manager enters the yearly rate **with its source**. Interest is shown per overdue instalment as *accrued, not charged*. Nothing is charged automatically |
| **GST / registration are statutory and separate** | GST (default 5 %, per plan) is shown separately on every instalment, demand and statement |
| **Receipts** | Append-only ledger: amount, mode, reference (no duplicate reference), voided only by a second person with a reason. Receipts are applied to demanded instalments oldest first |

Where: lead › Journey › **Payments** (statement, record registration, record receipt, demand letters, raise possession demand) and
Today › Team › **Construction & payment plans** (stages, certify, plans, TG-RERA number, interest rate).

### Needs Amaya's counsel / finance before go-live

- The real payment plan from the registered agreement (the demo plan is an **example**, marked as such).
- The interest rule number (sources cite Rule 15 and Rule 16) and the base (SBI MCLR vs prime lending rate); the current figure. A 2026 TG-RERA order applied 10.70 % (SBI MCLR + 2 %).
- Whether GST applies per instalment at 5 % for every unit type, and how registration / stamp duty and the maintenance deposit are collected (outside the instalments today).
- The demand-letter wording, and how many days the allottee has to pay (default 15).

## Customer engagement (`server/modules/engagement.ts`)

Follows Amaya's Sales SOP: *value-add follow-ups only, no check-in calls*; after booking: welcome call, handover to the customer
team, community preview, monthly progress updates, referral ask at 30 days.

- **Touches** are read from what the CRM already has (calls, WhatsApp, follow-up remarks, visits). Touches it cannot see are
  logged in a line: channel, what it was (progress update, event invite / attended, content, family meeting, community preview,
  referral ask, feedback…), with whom in the family, and whether they responded.
- **Health** per enquiry and per family member, from the last 90 days: *engaged* (responded within 14 days), *cooling* (15–30),
  *gone quiet* (over 30, or never despite 3+ touches), *too early to tell*.
- **Customer steps** after booking: welcome call, handed over (customer owner assigned), community preview, agreement registered
  (set by the registration), referral asked, possession, moved in. Logging a welcome call, community preview or referral ask ticks
  the step.
- **Today**: *Going quiet* (open enquiries cooling or quiet — send something of value) and *Customers: what is due* (each SOP step
  that is due, monthly progress update, re-engage), for the agent and the customer owner.

Not built yet: automatic monthly progress-update sends (would go through the WhatsApp consent policy and approved templates),
resident-community events calendar, NPS / satisfaction surveys, and possession / move-in checklists with documents.

## Sources

- RERA Act 2016, s. 13 (10 % before agreement), s. 2(za) (same interest rate), s. 19 (allottee's duty to pay).
- Telangana Real Estate (Regulation and Development) Rules 2017 — Rule 38 / Annexure A (agreement format); interest rule
  (15 or 16 — to confirm from the gazette).
- [TG-RERA order on delayed-possession interest at SBI MCLR + 2 % (10.70 %)](https://www.livelawbiz.com/amp/rera/telangana-rera-expresses-grave-concern-over-complaints-against-vasavi-realtors-flags-systemic-pattern-of-default-552098)
- [TG-RERA penalty for an agreement differing from the filed draft](https://www.mondaq.com/india/real-estate/1798838/statutory-compliance-over-contractual-deviation-telangana-rera-appellate-tribunal-upholds-penalty-for-promoters-agreement-violation)
- [Telangana RERA overview (interest rule citation)](https://www.grantthornton.in/globalassets/1.-member-firms/india/assets/pdfs/rerathe_state_affair.pdf)
- Amaya Sales SOP v1 (stages, SOP 14 booking, post-booking nurture) and the Phase 1 pre-launch price list (Medchal).
