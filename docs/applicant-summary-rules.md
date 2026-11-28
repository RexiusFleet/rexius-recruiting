# Applicant summaries: what Claude reads, writes and never does

This page is for HR. It says exactly what the **Summarize** button in an application's drawer
sends to Claude, what comes back, and what a summary must never contain. CLAUDE.md makes HR's
agreement to these rules the condition for using the feature, so read it before the first real
summary and tell an admin what to change.

The same rules are written into the prompt in
`supabase/functions/recruiting-applicant-summary/index.ts` (`SYSTEM_PROMPT`). Change the two
together, in one pull request.

## What a summary is for

A summary saves reading time. Claude reads one application against the position it was made
for and writes down, in plain English, what the applicant said that relates to that position,
what the application does not say, and an English translation of anything written in Spanish.
It is a reading aid. The decision about every applicant stays with HR and the hiring manager,
and nobody should decide anything from a summary without opening the application itself.

## What Claude reads

About the position:

- title, location and department;
- the text of the job description linked to the position, when one is on file as typed text.
  A description uploaded as a Word or PDF file cannot be read; in that case, or when no
  description is linked, Claude gets the text of the position's job page on rexius.com as the
  daily careers sync last saw it.

About other positions (see **Other positions** below):

- the title, location, department and description text of the other open and closed positions
  at the location the applicant applied to. Draft positions are left out. Whether a position is
  open or closed is not sent.

From the application, and nothing else:

- the form, the date it was received, the position and location applied for;
- the city and state the applicant lives in;
- the available start date, highest education, and the student or "no job experience" box;
- relevant skills, licences and certifications, other qualifications, and the notes HR typed in
  from a paper form;
- whether they worked at or applied to Rexius before, with the details they gave;
- forklift experience, herbicide spray licence, and driver licence class;
- employment history: employer, location, job title, dates, duties and reason for leaving.

## What Claude never receives

- The applicant's **name, email, phone numbers or address**. A summary says "the applicant".
- How they heard about the job, who referred them, and their preferred contact method.
- Former employers' phone numbers and supervisors' names and titles.
- Resumes, portfolios and scans. Claude reads the typed answers only.
- The answers about **age** (18 or older), **identity and work authorisation**, **ability to do
  the duties** (with or without accommodation), the **drug and alcohol policy**, and permission
  to contact a current employer.
- HR's notes, tags, status, offers, contact log, manager feedback, or anything from other
  applications.
- Driver licence numbers, signatures and initials, which the tracker never stores at all.

## What a summary contains

- **Overview**: two to four sentences of facts.
- **Related to the position**: jobs, skills and education that relate to the position, with
  employer, title, dates and duties as given.
- **Licences and certifications** the applicant states.
- **Availability** (the start date, and student status if given) and **Location** (where they
  live and where they applied).
- **Not stated in the application**: requirements or main duties of the position the
  application does not mention, each written as "Does not say whether …". These come from the
  job description, or, without one, only from what the job title clearly needs (a CDL for a
  truck driver).
- **Other positions this application relates to**: up to three, each with the stated facts
  behind it (next section but one).
- **Check in the application**: things HR should read in the original, such as a personal
  reason Claude left out (next section), text addressed to the reviewer, or answers that
  conflict.
- **English translation** of every written answer that is not in English, next to the original.

## What a summary never contains

- **No scores, ratings, rankings or comparisons** with other applicants.
- **No recommendation**: nothing that says or implies the applicant should be interviewed,
  hired or passed over, and no "good fit", "strong", "weak" or "ideal".
- **No opinions** about character, motivation, attitude, reliability or how often someone has
  changed jobs. Dates and stated reasons for leaving are reported without comment.
- **Nothing about protected characteristics**: age, sex or gender, race, ethnicity, national
  origin, citizenship or immigration status, religion, disability or health, pregnancy, family
  or marital status, sexual orientation, veteran status, or arrests and convictions. If an
  answer mentions one of these (a reason for leaving that mentions an injury or a family member,
  for example), the summary says only that a personal reason was given and lists it under
  **Check in the application**.
- **Language is not a qualification.** The summary notes the language of the answers only so HR
  knows how to reply. English or Spanish ability is mentioned only when the job description asks
  for it and the applicant states it.
- **No guesses.** Nothing the applicant did not write, and no skills inferred from a job title.

If a summary breaks any of these rules, do not use it. Tell an admin, with the date of the run,
so the prompt can be fixed. Every run is kept, so it can be found again.

## Other positions

The same run compares the application with the other positions at the location the applicant
applied to, open and closed, because many closed roles open again with the season. A CAS or
paper application with no location is compared with every location.

- A position is listed only when **something the applicant wrote meets a requirement or main
  duty stated in that position's description**: a licence it asks for, a named machine or
  vehicle, past work with the same duties. For a position with no description text, only what
  its title clearly requires counts.
- "Hard worker", "willing to do anything", education alone, and where the applicant lives are
  not grounds. Pay is not considered.
- Each position shows the facts that meet a requirement, and what the application does not say
  about that role ("Does not say whether …").
- **No score, no "good fit", no recommendation.** A listed position is a pointer for HR to
  read, not a suggestion to move, interview or hire anyone. Every rule under "What a summary
  never contains" applies to these lines too.
- **The order is not a ranking.** Claude names positions by a code; the tracker puts open
  positions first and then sorts by title. The tracker also throws away anything Claude names
  that it was not shown, the position the applicant applied for, and any entry with no fact.
- At most three positions. **None is the normal answer** for most applications, and the drawer
  says how many positions were compared.
- Nothing happens on its own. An application's position and stage change only when HR changes
  them.

On a position's page, **Other applications that relate to this role** lists the applications
whose newest summary named that position, newest application first. It is the list to read
when a seasonal role opens again; read the application before calling anyone. Hiring managers
see none of this.

**Summarize shown**, in the tracker's header, runs Summarize for the applications currently
shown that have no summary with this comparison yet: at most 25 a click, after a confirmation
that says how many and roughly what it costs.

## Translations

The translation is faithful and complete, and the applicant's original text is always shown
under it. The rule about protected characteristics does not trim a translation, because its
readers can already see the original.

Hiring managers never see a summary. When a summary has translated answers that a manager can
already read in the application (skills, licence class, employment history, paper-form notes,
the position as written), the manager's drawer and the application PDF show that English
translation too. Translations of other answers stay with HR.

## Translate a message

Under **Contact log**, HR can turn a reply into Spanish, or an applicant's Spanish message into
English. Nothing is sent to the applicant: the translation appears in the drawer to copy into an
email or text, and the message is not stored (only the cost is logged). Read the translation
over before sending it, and log the contact as usual.

## Where the data goes

The request goes to Anthropic's Claude API under Rexius' own Claude Console organization, in the
`recruiting` workspace with its monthly spending cap. Under Anthropic's published terms for
commercial API use, inputs and outputs are deleted from Anthropic's systems within 30 days
unless a request is flagged under the usage policy or the law requires longer (privacy.claude.com,
"How long do you store my organization's data?", updated 2026-07-01), and they are not used to
train models (privacy.claude.com, "Is my data used for model training?", updated 2026-08-18).

The summary itself is stored in the tracker with the application and is deleted with it.

## Cost

Five to ten cents a summary (more where the positions have long descriptions, less when
several run within five minutes of each other) and under a cent a message at 2026-11 list
prices. Each summary
shows its own cost; the Claude Console's Usage page shows the total for the `recruiting`
workspace.

## Before relying on it

Rules on the use of AI in hiring differ by state and are changing. A summary is built to stay a
reading aid, not a decision tool, but HR or counsel should confirm that using it fits Rexius'
policies and current law before it becomes part of the routine.
