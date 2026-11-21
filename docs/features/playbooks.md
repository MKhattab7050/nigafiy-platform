# Playbooks (approval-gated automation)

A playbook is a short list of steps. It starts when one of these happens:
- an event happens,
- an incident opens or resolves,
- a schedule comes due,
- someone starts it by hand.

Disruptive steps wait for an administrator's approval unless an administrator has explicitly allowed
them to run without asking. Every run records what started it, each step's input and result, and who
approved what.

**Status:** the API is covered by tests. The screens were checked against the local dev stack only,
with no collector online, so no step that needs a collector, router or agent has run end to end
through the UI.

## Where the code is

| Part | File |
| --- | --- |
| API (playbooks, runs, approvals, settings, engine) | `apps/api/src/modules/playbooks` |
| Step and trigger schema (the source of truth) | `apps/api/src/modules/playbooks/schema.ts` |
| Templates | `apps/api/src/modules/playbooks/templates.ts` |
| Screens | `apps/web/features/playbooks` |

## Screens

**`/playbooks`** has four tabs:

- **Playbooks.** The list shows each playbook's site, trigger, steps, badges (dry run, runs without
  asking, waiting for approval, running), last run and next scheduled run.
  - Administrators turn a playbook on or off with the switch. A refusal from the server is shown next
    to the switch.
  - When there are no playbooks, the tab points to the templates.
- **Approvals.** Lists every step waiting for an administrator, oldest first, next to the approval rules.
  - **Approve** and **Reject** follow the rights the server returns for the current user. When the
    user may not decide, the screen shows the server's reason instead of the buttons.
  - Rejecting needs a reason of at least 3 characters.
  - When the only administrator approves their own request, the screen says so first, because the
    server records it.
  - The approval rules are the two-person rule and how long a request stays open. Administrators edit
    them; everyone else reads them.
- **Run history.** Shows the latest runs, with a link to the full history.
- **Templates.**
  - The ready-made playbooks with their trigger and steps.
  - **Use this template** (admin) creates a *disabled* copy for the current site and opens it for
    review.

**`/playbooks/[id]`** (`/playbooks/new` for a new one) is the editor:

- Name, site, description, on/off, and "triggered runs are dry runs".
- The trigger: events with filters, incident opened or resolved, schedule (every N minutes or daily at
  a time), or manual.
- The steps. You can add, reorder and remove them, set a label, and choose what happens when a step
  fails (stop or continue).
  - Each step's fields match the API schema.
  - Device, router, check and notification-channel pickers load real data from the API. The channel
    list is admin only.
  - Each step shows a risk badge:
    - "Runs without asking" for a low-risk step.
    - "Disruptive: asks an administrator" when the mode is "always ask".
    - "Always asks an administrator" for router changes and approval gates.
- The approval mode.
  - Choosing "Run disruptive steps automatically" shows a confirmation checkbox.
  - Changing the trigger or steps of an automatic playbook shows the checkbox again.
  - Saving stays disabled until it is ticked. This mirrors the API's `auto_run_confirmed` rule.
- **Save.**
  - A new playbook is created with POST.
  - An existing one sends a PATCH of only the changed fields. Changing the trigger or steps bumps the
    version on the server.
  - Validation errors from the API appear on the step and field they belong to, and as a list.
- **Delete** (admin) asks for confirmation. Active runs are cancelled; finished runs stay.
- **Run now** (technician).
  - Choose the device that "the trigger's device" steps act on, and optionally a dry run.
  - When a device is required, the API's `device_required` answer is shown as a hint to pick one.
  - Starting opens the new run.
- **Recent runs** of this playbook.

Non-administrators see the editor read-only, with a note explaining why.

**`/playbooks/runs`** lists every run, newest first. You can filter by all, active or finished, and page
through the results.

**`/playbooks/runs/[id]`** shows one run:

- The status and the devices involved.
- What started it.
- A dry-run notice when nothing was changed.
- The run that caused it, if it was chained.
- Why it ended.
- A timeline of the steps. Each step shows:
  - its status, times, and input;
  - its result, including any `note` the step returned (for example, the DNS filter is off);
  - its error;
  - who approved or rejected it, any comment, and whether it was self-approved.
- Waiting steps carry the approve and reject buttons.
- **Cancel run**, when the server allows it (an admin, or the person who started the run). A
  confirmation explains that commands already sent are not recalled.

While a run is active, the page refreshes every 5 s and on live events.

**Dashboard widget.** Shows steps waiting for approval and runs in progress. Each waiting step also goes
to "Needs your attention". The sidebar badge counts the pending approvals.

## Roles

| Action | Role |
| --- | --- |
| Read playbooks, runs, approvals, approval rules | any |
| Run a playbook by hand | technician (its disruptive steps still wait) |
| Cancel a run | admin, or the person who started it |
| Create, change, enable, delete playbooks; templates; approval rules | admin |
| Approve or reject a step | admin (two-person rule permitting) |
