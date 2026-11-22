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

## Device-control and backup actions (added with migration 041)

| Action | What it does | Approval | Protections |
| --- | --- | --- | --- |
| `router_wifi` | Turns one Wi-Fi network of one router on or off (`routers/settings.ts setWifi`) | always (`alwaysApprove`) | same as the Routers page: refused when the collector host or the approving administrator's machine is on that network; turning off a main network needs `confirm_main_network`; a guest network cannot be on while its main network is off |
| `router_reboot` | Restarts one router (`rebootRouter`) | always | one pending reboot per router |
| `switch_port_quarantine` | Moves the device's own port to the quarantine VLAN (`ports/control quarantineDevice`) | always | only a port the device is alone on; refused on uplinks, trunks, ports with many devices, and the path to the collector, the gateway or the approver's machine — no override |
| `switch_port_disable` | `ifAdminStatus` down on the device's own port (`disableDevicePort`) | always | same as quarantine, no override |
| `config_backup` | Takes a read-only configuration backup of the device's backup target (or a named one) | never (low risk) | the target's readiness (credentials, host key, scope) as for "Back up now" |

The four disruptive actions are executed only inside the approving administrator's request (like the
router block / unblock / rate-limit steps), so the owning service audits them as that administrator's
and checks "your own machine" against the approver's address. A step reached outside an approval (API
restart in between) fails instead of acting. Router and switch steps then wait for the router request
(`router_requests`) or the switch request (`switch_port_requests`, done only when the collector read the
port back and it matched: status `verified`). The backup step waits for its `config_backup_runs` row
(trigger `playbook`).

Loop guard: the new actions declare the events they can cause (`produces` in `catalog.ts`): Wi-Fi and
reboot cause site-wide device / router / collector events; port steps cause `switch_port_changed`,
`switch_port_change_failed`, `device_offline` for the device; backups cause `config_changed`,
`config_backup_failed`, `config_host_key_changed` (now triggerable events, as are the switch port events).

Verified by tests (`tests/playbooks.test.ts`, `tests/switch-port-control.test.ts`): catalogue flags;
always-ask even in "run automatically"; unknown router refused when saving; a disable approved for a
device with no known port fails without a request; a disable of a direct port queues `admin_status
down` at approval only, completes on the verified read-back, and is audited; the gateway's port is
refused (`risky_port`) with nothing queued; quarantine through a playbook; backup step end to end; the
loop guard skipping the same playbook re-triggered by its own backup's `config_changed`, and skipping a
fourth playbook once three are already chained (`maxChainDepth`). These paths had no tests before. Not
run against a real router or switch.
