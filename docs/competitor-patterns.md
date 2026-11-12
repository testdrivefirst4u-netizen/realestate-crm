# Competitor Workflow Patterns for Amaya by Vera Vita

Research date: 10 Nov 2026. Scope: Sell.Do, LeadSquared, WelcomeHome, Pipedrive, Zoho CRM and Frappe CRM.
Method: public help centres, marketing pages and search-indexed help snippets. For Frappe CRM I also read the public GitHub source (read-only, commit `2cecd300`, 8 Nov 2026).
I did not sign up for anything, log in, or use a demo. **No pattern is hands-on.** Everything below is paraphrased; no vendor text, assets or code were copied.

Amaya journey these patterns map to:
Enquiry → RM assigned → follow-up → family consultation → site/virtual visit → unit shortlist → quotation → reservation (time-limited hold) → booking → post-sales (payment milestones, receipts).
The enquirer, the resident, the family decision-maker and the payer are often different people.

Likely touch points in this repo, judged by filename only (I did not review the code): `server/modules/{leads,tasks,calls,visits,inventory,salesOps,whatsappDirect}.ts`, `app/api/webhooks/telephony`, `app/api/cron/followups`.

---

## 1. Question checklist (planned before research)

| # | Product / focus area | Question | Evidence needed to answer it |
|---|---|---|---|
| Q1 | Sell.Do: inventory | How does Sell.Do block or hold a unit, who owns the hold, and how is it released? | Help article or product page showing unit states, hold owner and expiry, and the release trigger |
| Q2 | Sell.Do: visits | How is a site visit scheduled, confirmed, verified and followed up? | Visit states, the verification mechanism, and the feedback fields |
| Q3 | Sell.Do: quotation/booking | How do the cost sheet, booking states and the post-sales payment schedule connect? | Booking states, edit rules, and demand-letter triggers |
| Q4 | LeadSquared: routing | How are leads routed, and how are workload caps and shifts enforced? | Distribution rules, caps, and availability behaviour |
| Q5 | LeadSquared: telephony | What happens on a missed inbound call (lead creation, owner, status, dedupe)? | Telephony help or FAQ |
| Q6 | LeadSquared: SLA | Is there a response SLA with reassignment of untouched leads? | Automation docs naming time-based reassignment |
| Q7 | WelcomeHome: relationships | How are the prospect (resident) and family/influencer/referrer modelled? | Help-centre article on prospect and influencer records |
| Q8 | WelcomeHome: tours/cadence | How are tours and follow-up cadences run? | Features page, help docs |
| Q9 | Pipedrive: activities | How does the "always have a next activity" discipline show up in the UI? | Help articles on activity icons, the post-done prompt, and rotting |
| Q10 | Zoho: Blueprint | How do Blueprint transitions enforce required fields or evidence, and how do they interact with approvals? | Official Blueprint docs on transitions and approvals |
| Q11 | Zoho: messaging/telephony | How do WhatsApp (templates, 24-hour window) and telephony call logs work? | Official integration help |
| Q12 | Frappe CRM | How are Twilio, Exotel and WhatsApp set up and linked to records, and what is the licence? | Repository source and LICENSE |

---

## 2. Evidence register

| ID | Source | Type | Notes |
|---|---|---|---|
| E-01 | https://www.sell.do/real-estate-crm/inventory-and-negotiations/projects-towers-units | documented (marketing) | Unit states and hold owner/expiry. The FAQ answer on auto-expiry is blank. |
| E-02 | https://www.sell.do/real-estate-crm/sales-and-pre-sales/site-visit-management | documented (marketing, includes an illustrative demo UI) | Visit states, geo-fence, feedback |
| E-03 | https://www.sell.do/real-estate-crm/field-force-performance | documented (marketing) | OTP-verified visit completion |
| E-04 | https://www.sell.do/release-notes/new-features-added-in-sell-do-july-2020 | documented (release note) | Buyer must OTP-verify a visit request |
| E-05 | support.sell.do articles 6000113433 and 6000113222 (search-indexed snippets; both URLs now return 404) | documented (help, snippet only) | Tentative vs confirmed booking, cost-sheet lock |
| E-06 | support.sell.do articles 6000171891 and 6000171966 (snippets; 404 on fetch) | documented (help, snippet only) | Payment types/formulas, schedule per tower, demand letters |
| E-07 | https://www.sell.do/real-estate-crm/sales-and-pre-sales/task-escalation-management | documented (marketing) | First-response SLA ladder |
| E-08 | https://leadsquared.com/lead-distribution | documented (marketing) | Rules, round robin, caps, availability |
| E-09 | https://help.leadsquared.com/videos/how-to-set-limits-quotas-on-lead-distribution-user-level-assignment/ and the role-level variant | official video (titles and dates only; I did not watch them) | Confirms that user- and role-level quotas exist |
| E-10 | https://help.leadsquared.com/telephony-faq-troubleshooting/ | documented (help) | Missed-call ownership, statuses, dedupe, popup |
| E-11 | https://help.leadsquared.com/?p=6889 (Generic Telephony Connector, snippet) | documented (help) | Inbound popup, call log API |
| E-12 | https://www.leadsquared.com/sales-automation/ (snippet) | documented (marketing) | Missed calls reassigned to available reps |
| E-13 | https://welcomehomesoftware.zendesk.com/hc/en-us/articles/25788227143188-Prospects-Overview and the article 360043465572 (search snippets; direct fetch returned 403) | documented (help, snippet only) | Prospect vs influencer, relationship, second resident |
| E-14 | https://learn.roobrik.com/en/help-center/how-do-i-access-my-leads-in-welcomehome | documented (third-party integration help) | Form-filler becomes the influencer |
| E-15 | https://docs.talkfurther.com/integrations/crm-integrations/welcomehome | documented (third-party integration help) | Self-seeker vs searching-for-other; tour-reminder dedupe |
| E-16 | https://www.welcomehomesoftware.com/features | documented (marketing) | Sequences, post-tour surveys, call tracking |
| E-17 | https://welcomehomesoftware.com/faq | documented (marketing FAQ) | Family advocates, multi-contact profiles |
| E-18 | https://support.pipedrive.com/hc/en-us/articles/115001107229 and https://support.pipedrive.com/article/how-are-deals-ordered-in-the-pipeline-view (snippets) | documented (help) | Red/green/yellow/grey activity icon and sort order |
| E-19 | https://support.pipedrive.com/en/article/pipeline-view | documented (help) | Tile contents, default sort by next activity |
| E-20 | https://intercom.help/pipedrive/en/articles/14182532 (snippet; official status of this domain unverified) | documented (help, low authority) | Post-done popup setting; automation to create a follow-up |
| E-21 | https://support.pipedrive.com/en/article/the-rotting-feature (snippet) | documented (help) | Rotting resets; it ignores the next-activity date |
| E-22 | https://support.pipedrive.com/en/article/activities | documented (help) | Scheduling beside the calendar, done vs due |
| E-23 | https://help.zoho.com/portal/en/community/topic/effortlessly-advance-through-your-crm-blueprints-by-including-optional-fields-in-transitions | documented (official Zoho community announcement) | Mandatory/optional transition fields, checklist, drafts |
| E-24 | https://help.zoho.com/portal/en/kb/crm/process-management/blueprint/articles/blueprint-an-overview | documented (help) | Purpose and example stages only |
| E-25 | https://help.zoho.com/portal/en/kb/crm/connect-with-customers/business-messaging/articles/whatsapp-integration | documented (help) | WhatsApp setup, templates, 24-hour window, Messages module |
| E-26 | https://help.zoho.com/portal/en-gb/community/topic/new-in-zoho-crm-zoho-phonebridge and https://prezohoweb.zoho.com/voice/help/zoho-crm-telephony-integration.html (snippets) | documented | PhoneBridge call logging and notes |
| E-27 | https://github.com/frappe/crm: `crm/integrations/exotel/handler.py`, `crm/integrations/twilio/*`, `crm/fcrm/doctype/crm_{exotel,twilio}_settings`, `crm_call_log`, `crm_telephony_agent` | source (public repo, read-only) | Telephony setup and call-log model |
| E-28 | https://github.com/frappe/crm: `crm/api/whatsapp.py`, `crm/integrations/api.py` | source (public repo, read-only) | WhatsApp lead linking, phone-change guard, notifications |
| E-29 | https://github.com/frappe/crm: `crm_service_level_agreement`, `crm_lead.json` SLA fields, `crm_availability_status`, `crm_form_script`, `LICENSE` | source (public repo, read-only) | SLA, availability, extensibility, AGPL-3.0 |
| E-30 | https://frappe.io/crm/integrations | documented (marketing) | Integration overview |

---

## 3. Pattern ledger

Each pattern lists **Observed** (what the source actually says or shows), **Inferred** (my reading of it), **Unknown** (not evidenced), and an adaptation for this Next.js + MongoDB CRM.

### Sell.Do (Indian real-estate CRM)

#### SD-1: Unit hold with a named owner and an expiry, as a single source of truth
- **Evidence:** E-01 · documented · confidence **medium**
- **Role / task:** Sales RM reserving a unit while the family decides.
- **Observed:** Units carry one live state: Available, Held, Blocked or Booked. Each hold has an owner and an expiry, and the stated goal is that units are never reserved indefinitely. A second rep who opens a held unit sees that it is held, by whom, and until when, rather than a stale copy.
- **Inferred:** Holds are a first-class record, not a free-text note, and the conflict state shows the holder and expiry so the second rep can escalate instead of double-selling.
- **Unknown:** Whether expiry auto-releases (the FAQ answer is blank), whether holds can be extended, who approves an extension, and whether a deposit is needed.
- **Why it matters for Amaya:** Reservation is an explicit stage. NRI families need days to confer across time zones, so holds must expire fairly and visibly.
- **Adapt:** Add `hold: {leadId, ownerId, expiresAt, reason, extendedCount}` to the inventory unit.
  - Acquire the hold with an atomic `findOneAndUpdate({_id, status:'available'}, {$set:{status:'held', hold}})`. A null result is the conflict, so show "Held by X until Y" with a "Request handover" action.
  - Release expired holds with a cron sweep, notify the RM 24 hours before expiry, and require manager approval for a second extension.

#### SD-2: Verified site-visit lifecycle (OTP and geo-fenced check-in)
- **Evidence:** E-02, E-03, E-04 · documented · **medium**
- **Role / task:** GRE or RM receiving the family at the site; manager auditing visit counts.
- **Observed:**
  - Visit request: a homebuyer OTP-verifies the visit request (2020 release note).
  - At the site: an OTP is sent while the customer is on site, and the rep enters it to mark the visit done.
  - Check-in: check-in is geo-fenced to the project (the demo shows 200 m), and a remote attempt is blocked and logged with its distance.
  - States shown: Scheduled, En route, Checked in, No-show risk.
- **Inferred:** "Visit done" is proof-backed, which protects visit-based incentives and channel-partner claims.
- **Unknown:** Reschedule and cancel states, what happens after a no-show, and how revisits are handled.
- **Why it matters for Amaya:** Senior-living visits are often made by the parents alone, with the child joining on video. Verifying who actually attended matters.
- **Adapt:** Visit `status: scheduled|confirmed|checked_in|completed|no_show|rescheduled|cancelled`, with `attendees[]` (person refs plus `mode: in_person|video`).
  - Verify completion by sending a WhatsApp OTP or confirmation to the attendee's number, or by recording the device location against the project coordinates.
  - On mismatch, keep the record and flag it as `unverified`; do not silently drop it.

#### SD-3: Pre-visit confirmation and structured post-visit feedback
- **Evidence:** E-02 · documented (marketing) · **medium**
- **Observed:**
  - Before the visit: upcoming visits are auto-confirmed over WhatsApp, and unconfirmed ones are flagged as no-show risk and nudged.
  - The rep is reminded to share a cost sheet for the unit the buyer viewed most.
  - After the visit: the rep captures interest level, objections, next step and close probability on mobile.
- **Inferred:** The feedback form drives the next task automatically.
- **Unknown:** Whether the fields are mandatory and how the reschedule flow works.
- **Adapt:** The visit-completion form requires `interest (1–5)`, `objections[]` (enum: price, location, care services, food, family not convinced…), `nextStep` (date and type), and `unitsViewed[]`.
  - Saving the form creates the next task (see PD-1) and seeds the shortlist.

#### SD-4: Tentative vs confirmed booking, with the cost sheet locked on confirmation
- **Evidence:** E-05 · documented (help snippet; the article now returns 404) · **medium-low**
- **Observed:**
  - The booking holds the unit, areas, floor, base rate and charges.
  - While tentative, the cost sheet and payment schedule can be edited. Once confirmed, they cannot.
  - Post-sales users can only email or call the customer, or send the cost sheet and schedule, while the booking is tentative.
- **Inferred:** "Confirm" acts as a commit point that freezes commercial terms. Later changes need a separate amendment or cancellation path.
- **Unknown:** Cancellation, transfer and refund flows, and who confirms.
- **Why it matters for Amaya:** It separates the reservation (soft) from the booking (hard) and protects quotes from silent edits.
- **Adapt:** Use a `quotation` collection with `version`, `status: draft|sent|accepted|superseded|expired`, and a `validUntil` date.
  - The booking references an accepted quotation version, and confirming it writes an immutable snapshot.
  - Any post-confirmation change creates an `amendment` with an approver.

#### SD-5: Payment schedule per tower, formula charges, demand letters by construction stage
- **Evidence:** E-06 · documented (help snippet) · **low-medium**
- **Observed:**
  - Admins configure payment types (agreement value, taxes), with formulas such as a percentage of agreement value.
  - A payment schedule is configured per tower.
  - Demand letters are generated from the schedule plus the project or tower construction status.
- **Unknown:** The receipt flow, partial payments, interest on delay, and payer identity.
- **Why it matters for Amaya:** Payment milestones and receipts are in scope, and the payer is often a child abroad, so payments may arrive in foreign currency through NRE/NRO accounts.
- **Adapt:** A `paymentPlan` template per project or tower, with `milestones[{label, trigger: date|constructionStage, pct|amount}]`.
  - On booking, instantiate `dues[]` with a `payerPersonId`.
  - A construction-stage update raises demands and drafts letters for review, not auto-send.
  - `receipts[]` link to dues and allow partial allocation.

#### SD-6: Working-hours-aware first-response SLA ladder
- **Evidence:** E-07 · documented (marketing) · **medium**
- **Observed:**
  - Example ladder: assign → reminder to the rep → alert to the team lead → reassign and escalate. It runs on a 15-minute SLA, with steps at 0, 15, 30 and 60 minutes.
  - Timing: the SLA counts working hours and shifts, so a late-night lead breaches in the next working window and nobody is paged at night.
  - UI states: "Due in 4m", "Breaching now", and "Breached 12m".
- **Unknown:** Snooze or pausing, and per-source SLAs.
- **Why it matters for Amaya:** NRI enquiries arrive overnight IST. A working-hours clock avoids false breaches, but a "contact them in their own morning" task is still needed.
- **Adapt:** On lead creation, compute `firstResponseDueAt` from a working calendar.
  - A cron in the existing `cron/followups` route walks the escalation steps, and each step is logged on the lead.
  - The first logged call, WhatsApp message or email sets `firstRespondedAt`. Compare FR-4.

### LeadSquared

#### LS-1: Rule-based distribution with round robin inside shifts and per-agent caps
- **Evidence:** E-08, E-09 · documented, plus official video titles · **medium**
- **Role / task:** Sales manager configuring who gets which enquiry.
- **Observed:**
  - Routing: route by lead attributes (location, product, source, language) and agent attributes (seniority, performance).
  - Round robin: rotation can be restricted to agents on shift.
  - Caps: per-agent caps, with overloaded agents skipped. User- and role-level quotas exist (video titles).
  - Plan: this is a paid "Distribution Engine" feature.
- **Unknown:** What happens when every agent is capped or off shift (the fallback queue).
- **Why it matters for Amaya:** It lets NRI or language-matched RMs take overseas enquiries without overloading a small team.
- **Adapt:** An `assignmentRules[]` collection, ordered: `match` (source, country, language, budget), a `pool` of userIds, a `strategy: round_robin|least_loaded`, and `dailyCap`.
  - Keep the round-robin cursor and daily counters in one document, updated atomically.
  - With no eligible agent, assign to an "Unassigned" queue that has its own SLA and alerts the manager.

#### LS-2: Availability status and bulk reassignment
- **Evidence:** E-08 · documented · **medium**
- **Observed:** Agent status (online, idle, busy, off-shift) feeds distribution. When an agent leaves, their leads can be reassigned in bulk by criteria, which avoids orphaned leads. Urgent enquiries can jump the queue.
- **Unknown:** Whether status is set manually or detected.
- **Adapt:** `user.availability` (manual toggle plus shift calendar). Add a manager screen: "Reassign all open leads of X", with a preview count and per-stage filters, and an audit entry per lead.

#### LS-3: Missed inbound call creates or matches a lead with "System" ownership until someone engages
- **Evidence:** E-10, E-12 · documented (help) · **high** for the ownership rules
- **Observed:**
  - Ownership: a lead created from a missed inbound call is owned by "System". Ownership moves to whoever next has a successful call, and an agent calling a System-owned lead becomes its owner.
  - Statuses: missed inbound is recorded as "Missed", while unanswered outbound is "NotAnswered".
  - Matching: before creating a lead, the system checks both the phone and mobile fields. If several leads share a number, the log attaches to the most recently modified one.
  - Unknown numbers: lead creation from unknown inbound numbers can be switched off.
  - Separately, marketing copy lists "reassign missed calls to available reps".
- **Inferred:** The ownership fallback avoids losing a lead when nobody answers, at the cost of some ambiguity.
- **Why it matters for Amaya:** Families often call back from different numbers (the child's foreign mobile, the parent's landline). Missed calls are high-intent.
- **Adapt:** In `webhooks/telephony`, normalise to E.164 and match against all phone fields of all linked persons (see WH-1). A shared number produces an ambiguity flag rather than a silent pick.
  - For a missed call on an owned lead, create a "Call back within 15 min" task for the owner, falling back to the on-shift pool.
  - For an unknown number, create a lead in the Unassigned queue with `source: missed_call`.

#### LS-4: Inbound call popup with lead context, then a disposition after the call
- **Evidence:** E-10, E-11 · documented · **medium**
- **Observed:**
  - An incoming-call popup appears for the routed user, controlled by a profile permission and shown across tabs.
  - Call disposition records structured outcome data after the call.
  - Activity time comes from the provider's start time, not the time the log arrived. Logs and recordings may arrive late from the provider.
  - Failed calls appear only in an admin activity list, not in the lead history.
- **Error states (documented):** popup not shown (mapping or number-format issues), click-to-call failed or not connected, and missing logs because of provider timeouts.
- **Adapt:** Show a popup or toast with the lead card, stage and last note. After the call ends, require a disposition (connected-interested / call back / wrong number / not reachable…), and the disposition creates the next task.
  - Upsert call logs by provider call id, so late or duplicate webhooks are idempotent, and attach the recording when it arrives.

### WelcomeHome (senior living)

#### WH-1: Prospect (resident) vs influencer (family contact), with an explicit relationship
- **Evidence:** E-13, E-14, E-15, E-17 · documented (help snippets plus third-party integration docs) · **medium**
- **Role / task:** Counselor taking an enquiry from a daughter about her mother.
- **Observed:**
  - Two roles: the prospect is the person who would move in. The influencer is the main point of contact, linked by a relationship field.
  - Form submissions: when someone fills a form on behalf of another person, the form-filler becomes the influencer and the prospect record is named after the care recipient. An integration's default is that self-seekers are prospects and those searching for others are influencers.
  - Records: the profile shows the influencer and second-resident details together, and a record can be switched between prospect and influencer.
  - Family: the FAQ positions family advocates and multi-contact profiles as core.
- **Inferred:** The deal or prospect sits on the resident, while communication defaults to the influencer.
- **Unknown:** How payer or legal decision-maker roles are modelled. There is no explicit "payer" field in the evidence.
- **Why it matters for Amaya:** This is the closest documented match to Amaya's enquirer, resident, decision-maker and payer split.
- **Adapt:** Keep the lead as the opportunity, and add `people[]` holding a personId, `roles` (enquirer, resident, co_resident, decision_maker, payer, referrer, poa), relationship, `preferredChannel`, `timezone`, `country` and `isPrimaryContact`.
  - Calls and WhatsApp messages match on any person's number (LS-3).
  - The quotation is addressed to the decision-maker, and dues go to the payer.

#### WH-2: Second resident and role switching
- **Evidence:** E-13 · documented (snippet) · **low-medium**
- **Observed:** A second resident (for example a spouse) can sit on the same prospect profile, and a person can be converted from prospect to influencer and back.
- **Why it matters for Amaya:** Couples moving in together, or a parent who later becomes the influencer for a sibling.
- **Adapt:** Allow two `resident` roles per lead. The unit-fit check (occupancy, accessibility needs) considers both residents. Changing a role is a logged action, not a delete.

#### WH-3: Behaviour-triggered multi-channel follow-up sequences
- **Evidence:** E-16 · documented (marketing) · **medium**
- **Observed:** Multi-step sequences across email, text and tasks are triggered by prospect behaviour. Dynamic lists update as the pipeline changes. Call tracking transcribes and scores marketing calls, and qualified prospects enter sequences.
- **Unknown:** Sequence exit and pause rules, and per-person targeting (prospect vs influencer).
- **Adapt:** Extend the existing drip/sequence module so each step targets a role (for example, the influencer receives the brochure and the resident receives a call task). Sequences exit automatically on stage change or a reply.

#### WH-4: Automatic post-tour survey tied back to the record and the outcome
- **Evidence:** E-16, E-15 · documented · **medium**
- **Observed:**
  - A survey is sent automatically when the tour ends, and responses post to the prospect record in real time.
  - Reporting connects survey results to deposits and move-ins.
  - A partner integration suppresses its own reminder when a tour is already booked in WelcomeHome, which avoids duplicate reminders.
- **Adapt:** On visit `completed`, send a short WhatsApp survey to each attendee (in-person and video separately). Store the replies on the visit.
  - Use a single "reminder owner" per visit so other automations skip it.

### Pipedrive

#### PD-1: "Next activity" indicator and urgency sort on every deal
- **Evidence:** E-18, E-19 · documented (help) · **high**
- **Role / task:** RM scanning their pipeline for what to do now.
- **Observed:**
  - Each deal card shows an activity-state icon: red = overdue, green = due today, yellow = nothing scheduled (the user is prompted to add one), grey = scheduled in the future.
  - Default sort puts overdue and today's deals first, then deals with no activity, then future ones.
  - Clicking the icon lists upcoming activities and lets the user mark one done or schedule a new one inline.
- **Why it matters for Amaya:** Long, multi-person decision cycles go cold silently. Treating "no next step" as a visible defect is the cheapest win.
- **Adapt:** Denormalise `nextTask: {id, dueAt, type}` on the lead, maintained on task create, complete and delete. Derive the badge state from it in the list and kanban views.
  - Add an index on `{ownerId, 'nextTask.dueAt'}` for the "My day" view.

#### PD-2: Prompt for the next activity after marking one done
- **Evidence:** E-20 (low authority), E-21 · documented · **medium-low**
- **Observed:** A popup appears after an activity is marked done, governed by a user setting. Automation can create a follow-up N days after a done activity.
- **Unknown:** Whether the prompt is suppressed for won or lost deals (users have asked for that).
- **Adapt:** Completing a task or call disposition opens "What's next?" with presets (call tomorrow, WhatsApp the brochure, book a visit).
  - Skipping requires a reason, or is allowed only on closed stages.

#### PD-3: Rotting (stage inactivity) separate from scheduled activity
- **Evidence:** E-21 · documented (help snippet) · **medium**
- **Observed:** A deal rots, shown as a red tile, after a configurable number of idle days per stage. Marking activities done and other updates reset the count. Rotting ignores the next-activity date, so a deal with a far-future activity can still rot.
- **Inferred:** Two independent signals: "do you have a plan" (PD-1) and "has anything happened" (rotting).
- **Adapt:** A per-stage `maxIdleDays` (for example, Reservation = 2 days to match the hold, Family consultation = 5). Compute it from `lastActivityAt` and show it separately from the next-task badge.

#### PD-4: Scheduling beside the calendar, and done time kept separate from due time
- **Evidence:** E-22 · documented (help) · **high**
- **Observed:** The scheduling dialog shows the user's day calendar next to the form, to avoid double-booking. Busy/Free applies to scheduler links. The "marked done" time is stored separately from the due date. Linking an activity to a deal also links its contact and organisation.
- **Adapt:** The visit-booking modal shows the RM's and the site's slots for that day. A slot conflict blocks the save with a message naming the clashing visit. Store `completedAt` separately from `dueAt`, so SLA and lateness reports stay honest.

### Zoho CRM

#### ZO-1: Blueprint transition forms with required fields and checklist items
- **Evidence:** E-23, E-24 · documented (official announcement plus overview) · **medium**
- **Role / task:** Admin enforcing "you cannot move to Reservation without X".
- **Observed:**
  - Blueprint models a process as stages, with transitions between them, and the transition form gates movement to the next stage.
  - Transition fields and checklist items can be mandatory or optional (previously everything was mandatory).
  - A field is mandatory if the module field or a layout rule says so.
  - The transition form can be saved as a draft and resumed later.
  - The overview's example stages include "Negotiation" to "Discount Approved".
- **Unknown:** I was unable to fetch the official building-blocks, approvals and SLA articles (404 or not found).
  - The before/during/after structure, transition owners, attachments as required evidence, and approval interplay are therefore **not verified here**.
  - A third-party blog claims only workflow rules can override Blueprint actions. That is unverified.
- **Why it matters for Amaya:** It encodes evidence gates: no quotation without a shortlisted unit and a confirmed decision-maker, no reservation without an accepted quotation and a hold, no booking without KYC, a token receipt and a payer.
- **Adapt:** Use a server-side `stageTransitions` map of `from→to` with `requiredFields[]`, `requiredArtifacts[]` (for example `quotation.accepted`, `receipt.token`, `visit.completed`), `allowedRoles[]` and `needsApproval`.
  - The API rejects a move with a list of the missing items, and the UI shows it as a checklist.
  - Let users save a partial transition as a draft.

#### ZO-2: Approval-gated discount stage
- **Evidence:** E-24 · documented (example only) · **low**
- **Observed:** The example process includes a "Discount Approved" stage after Negotiation, implying an approval step in the flow. Sell.Do also claims "approval-driven negotiations" (E-01).
- **Unknown:** Approver routing, thresholds, and rejection handling.
- **Adapt:** A quotation discount above a threshold sets `approval: pending`, notifies the approver, and blocks "Send quotation" until it is approved. A rejection returns the quotation to draft with a comment.

#### ZO-3: WhatsApp with templates, the 24-hour window, and an unreplied view
- **Evidence:** E-25 · documented (help) · **high**
- **Observed:**
  - Setup: only an admin can connect WhatsApp, and setup chooses whether new numbers become leads or contacts.
  - Templates: templates have a module, language and category (utility or marketing). They go to Meta for approval and cannot be edited while under review or after approval.
  - Messaging window: reps can reply freely only within 24 hours of the customer's last message. Otherwise an approved template is needed.
  - Inbox: the Messages module lets reps filter unreplied threads and threads by owner. Signals let reps create a task or meeting from a message.
- **Why it matters for Amaya:** WhatsApp is the main channel with NRI families, and the 24-hour rule is the main source of "message failed" confusion.
- **Adapt:** Store `windowExpiresAt` per person and number, updated on every inbound message. The composer shows a countdown. After expiry it switches to the template picker, with a clear reason.
  - Add an "Unreplied > 2h" inbox filter.
  - Track template status (pending, approved, rejected) and block sending pending templates.

#### ZO-4: Telephony call log with notes attached to the call record
- **Evidence:** E-26 · documented (snippets) · **medium-low**
- **Observed:** PhoneBridge connects the PBX so CRM context is available during inbound and outbound calls. Post-call notes save against the call record in the Calls module. A dial pad can log call details against an existing lead or contact.
- **Adapt:** The same pattern as LS-4. Make the note part of the call document, not a separate free-floating note, so call reports can include outcomes.

### Frappe CRM (open source; licence **AGPL-3.0**: patterns only, no code reuse)

#### FR-1: Per-provider settings, per-agent telephony mapping, and a normalised call log
- **Evidence:** E-27, E-30 · source (read-only) · **high**
- **Observed:**
  - Provider settings: Twilio and Exotel each have a settings record (enabled flag, account credentials, record-calls toggle, and for Exotel a subdomain plus a webhook verify token checked on each callback).
  - Agents: each agent has a mapping with their numbers, a default medium and a call-receiving device.
  - Call log fields: a provider call id, direction (incoming or outgoing), a status from a fixed list (initiated, ringing, in progress, completed, failed, busy, no answer, queued, canceled), duration, recording URL, caller and receiver users, a link to a note and a task, and a polymorphic reference to the lead or deal.
  - Unknown provider statuses are mapped through a table, and unmapped values are logged as errors instead of breaking the request. Inbound webhook requests are themselves logged with completed or failed status.
  - Realtime: a realtime event pushes the call to the agent.
- **Why it matters for Amaya:** Indian telephony (Exotel and similar) sends inconsistent status strings and duplicate callbacks.
- **Adapt:** A `telephonyProviders` settings doc per tenant; `user.telephony {numbers[], defaultMedium}`.
  - Verify webhooks with a shared secret, and keep a `webhookLog` collection for replay and debugging.
  - Map statuses through an explicit table, and treat unknown statuses as an error log entry rather than a 500.

#### FR-2: Phone-number resolution to contact, lead or deal, and opt-in lead creation for unknown WhatsApp senders
- **Evidence:** E-27, E-28 · source · **high**
- **Observed:**
  - Matching: incoming calls and WhatsApp messages are resolved by digit-normalised number matching (contact first, then its lead or deal).
  - Unknown WhatsApp senders: a lead is created only if the WhatsApp account is configured to append incoming messages to leads, which acts as the opt-in. The new lead gets a WhatsApp source, and resolution errors are logged without blocking the message.
  - Notifications: assigned users are notified of new inbound WhatsApp messages, with a link to the record.
- **Adapt:** A single `resolveByPhone(e164)` service used by calls, WhatsApp and missed-call webhooks, returning all matches so ambiguity can be surfaced. Lead creation from unknown numbers is a tenant setting. Notify all assignees of the lead.

#### FR-3: Guard against changing a lead's phone number when a WhatsApp thread exists
- **Evidence:** E-28 · source · **high**
- **Observed:** Saving a lead or deal with a different mobile number is refused unless the user confirms, when there are existing WhatsApp messages with the old number. The prompt explains how many messages exist and that replies from the old number will no longer appear on the record. Automated (non-interactive) saves skip the guard.
- **Why it matters for Amaya:** Families swap the "primary" number between parent and child often. Silent loss of the thread is a real failure mode.
- **Adapt:** With `people[]` (WH-1), prefer adding a number over replacing one. If a number is replaced, show a confirmation with the message count, and keep the old number as `inactive` so history still resolves.

#### FR-4: SLA fields on leads, working calendar, and availability statuses
- **Evidence:** E-29 · source · **high** (schema), **medium** (runtime behaviour not executed)
- **Observed:**
  - SLA definitions: a definition has an applicability condition, priorities, working hours, a holiday list, an optional date range and a "rolling responses" flag.
  - Lead SLA fields: an SLA status (first response due, rolling response due, failed, fulfilled), a "response by" deadline, the first response time and the first-responded-on timestamp.
  - Availability: configurable availability statuses have categories, colours and order.
  - Assignment rules and per-doctype form scripts (JavaScript for the form or list view) are the extensibility points.
- **Inferred:** The "rolling response" flag means the SLA restarts after each customer message, not only for the first reply.
- **Adapt:** Combine with SD-6. Store `sla {policyId, status, dueAt, firstRespondedAt}` on the lead. For WhatsApp, rolling SLA re-arms on each inbound message when the lead is in active stages. Holiday list per tenant.

---

## 4. Top 10 for Amaya (ranked)

1. **Unit hold with owner, expiry and atomic conflict state** (SD-1). This is the reservation stage itself and prevents double-selling. Use a Mongo conditional update, a cron release and pre-expiry alerts.
2. **People-and-roles on a lead** (WH-1, WH-2). Covers enquirer, resident(s), decision-maker, payer and referrer, each with their own timezone and channel. It is foundational for everything else.
3. **Next-activity rule** (PD-1, PD-2). Show a red, green, yellow or grey badge, sort by urgency, and prompt "What's next?" on every completion or disposition.
4. **Working-hours first-response SLA ladder** (SD-6, FR-4). Remind, alert the lead, then reassign. For NRI enquirers, also schedule contact in their local morning.
5. **Stage gates with required evidence** (ZO-1). Gate on a quotation accepted before reservation, and a token receipt plus payer before booking, returned as a checklist of missing items.
6. **Missed-call capture and callback task** (LS-3, FR-2). Match the number across all linked people, flag ambiguous matches, and route unknown numbers to an Unassigned queue with an SLA.
7. **Capacity- and shift-aware distribution** (LS-1, LS-2). Rules, then round robin with daily caps, then a fallback queue, plus bulk reassignment when an RM leaves.
8. **Verified visit lifecycle with structured feedback** (SD-2, SD-3, WH-4). Covers WhatsApp confirmation, no-show risk, in-person vs video attendees, required feedback and a post-visit survey.
9. **Versioned quotation and tentative-to-confirmed booking with a payment plan** (SD-4, SD-5, ZO-2). Covers discount approval, an immutable snapshot on confirmation, milestones assigned to the payer, and receipts allocated to dues.
10. **WhatsApp window awareness and number-change guard** (ZO-3, FR-3). Show a 24-hour countdown, fall back to templates, add an "unreplied" filter, and never silently orphan a thread.

---

## 5. Checklist revisited

| # | Status | Basis |
|---|---|---|
| Q1 Sell.Do hold/release | **Partially answered** | States, owner, expiry and the conflict display are documented (E-01). The release mechanism (automatic vs manual) and extension rules are unresolved. |
| Q2 Sell.Do visits | **Partially answered** | Scheduling, confirmation, OTP/geo check-in and feedback are documented (E-02 to E-04). Reschedule, no-show aftermath and revisits are unresolved. |
| Q3 Sell.Do cost sheet/booking/payments | **Partially answered** | Comes from search snippets of help articles that now return 404 (E-05, E-06). Receipts, cancellation and transfer are unresolved. |
| Q4 LeadSquared routing/caps | **Answered (documented level)** | E-08, E-09. The setup steps inside the videos were not watched, and the fallback when all agents are capped is unresolved. |
| Q5 LeadSquared missed call | **Answered** | E-10 (official FAQ). |
| Q6 LeadSquared response SLA/reassign | **Unresolved** | Only "reassign missed calls" marketing copy (E-12). No help doc on time-based reassignment of untouched leads was found. |
| Q7 WelcomeHome relationships | **Partially answered** | Prospect/influencer/relationship/second resident come from help snippets and third-party docs (E-13 to E-15). The full article was blocked (403), and payer modelling is unknown. |
| Q8 WelcomeHome tours/cadence | **Partially answered** | Sequences and post-tour surveys are documented (E-16). Tour scheduling UI and cadence rules are unseen. |
| Q9 Pipedrive next activity | **Answered** | E-18, E-19, E-21, E-22. The post-done prompt comes from a lower-authority source (E-20). |
| Q10 Zoho Blueprint | **Partially answered** | Mandatory/optional transition fields, checklists and drafts are documented (E-23). Before/during/after, owners, attachments, SLA and approvals were not verified (the official articles could not be fetched). |
| Q11 Zoho WhatsApp/telephony | **Answered (WhatsApp) / partially (telephony)** | E-25 is official and detailed. Telephony is from snippets only (E-26). |
| Q12 Frappe CRM setup and licence | **Answered** | Source read (E-27 to E-29). The licence is AGPL-3.0. Runtime behaviour was not executed. |

**The research is not complete.** Q6 is unresolved, and Q1–Q3, Q7, Q8 and Q10 are only partially answered.

## 6. What I could not verify

Nothing here was observed hands-on. I used no demos or trials, and logged into nothing, so every loading, empty, error and recovery state comes from documentation text, marketing mock-ups or (for Frappe) source code I read but did not run.

The weak spots:
- **Sell.Do help:** several articles now return 404, so their content comes only from search snippets. Its marketing pages leave key FAQ answers blank, including whether holds expire automatically.
- **WelcomeHome:** the Zendesk help centre returned 403, so the influencer and second-resident details come from snippets and partner docs.
- **Zoho Blueprint:** the detailed articles (building blocks, approvals, SLA escalation) could not be fetched. The before/during/after structure, attachment-as-evidence and the approval interplay are not verified.
- **LeadSquared:** the quota setup is known only from video titles, and I found no documentation of time-based reassignment of untouched leads.
- **Pipedrive:** the post-done prompt comes from a help domain whose official status I could not confirm.
- **Marketing claims:** statements such as "zero double bookings", or the visit-reminder percentages, were treated as claims, not evidence.
