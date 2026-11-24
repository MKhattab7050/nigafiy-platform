import { z } from 'zod';

/** POST /endpoints/:id/remote-desktop/start */
export const rdStartSchema = z
  .object({
    display_index: z.number().int().min(0).max(8).default(0),
    quality: z.number().int().min(25).max(95).default(68),
    scale: z.number().min(0.25).max(1.0).default(0.75),
    // Record the session (the profile needs "record" and the group's policy must allow it; a group
    // that requires recording records every session whatever this says).
    recording_enabled: z.boolean().default(false),
    // Started from a Wake-on-LAN request (POST .../remote-desktop/wake) once the computer came online.
    wake_request_id: z.uuid().optional(),
    // Why the operator connects (required); shown to the user in the consent dialog and on the banner.
    reason: z.string({ error: 'Give the reason for the session' }).trim().min(3, 'Give the reason for the session (at least 3 characters)').max(200),
    // A permission profile within the policy's maximum (default: the policy's default profile).
    profile_id: z.uuid().optional(),
    // From POST /fleet/step-up when the policy requires MFA to connect.
    step_up_token: z.string().max(200).optional(),
  })
  .strict();
export type RdStart = z.infer<typeof rdStartSchema>;

/** Command kinds of a remote desktop session (sent through POST /endpoints/:id/commands). */
export const rdCaptureCommandSchema = z
  .object({
    kind: z.literal('rd_capture'),
    display_index: z.number().int().min(0).max(8).default(0),
    quality: z.number().int().min(25).max(95).default(65),
    scale: z.number().min(0.25).max(1.0).default(0.75),
    // Send the image even if the screen did not change (the viewer has no frame yet).
    full_frame: z.boolean().optional(),
  })
  .strict();

export const rdInputCommandSchema = z
  .object({
    kind: z.literal('rd_input'),
    event_kind: z.enum(['mouse_move', 'mouse_click', 'mouse_down', 'mouse_up', 'mouse_wheel', 'key_press', 'key_down', 'key_up', 'key_combo', 'text']),
    display_index: z.number().int().min(0).max(8).default(0),
    x: z.number().min(0).max(1).default(0.5),
    y: z.number().min(0).max(1).default(0.5),
    button: z.enum(['left', 'right', 'middle']).default('left'),
    double: z.boolean().optional(),
    delta_y: z.number().int().min(-2400).max(2400).optional(),
    key: z.string().max(40).optional(),
    text: z.string().max(240).optional(),
    ctrl: z.boolean().optional(),
    alt: z.boolean().optional(),
    shift: z.boolean().optional(),
    meta: z.boolean().optional(),
    // key_down / key_up: the physical key (KeyboardEvent.code), sent by position so the remote
    // keyboard layout decides the character; key_combo: up to 4 codes pressed together.
    code: z.string().regex(/^[A-Za-z0-9]{1,24}$/).optional(),
    keys: z.array(z.string().regex(/^[A-Za-z0-9]{1,24}$/)).min(2).max(4).optional(),
  })
  .strict();

/** POST /endpoints/:id/remote-desktop/recording */
export const recordingToggleSchema = z.object({ on: z.boolean() }).strict();

/** GET /fleet/recordings */
export const recordingListQuery = z
  .object({
    endpoint_id: z.uuid().optional(),
    fleet_session_id: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
export type RecordingListQuery = z.infer<typeof recordingListQuery>;

export const recordingSegmentParams = z.object({ id: z.uuid(), name: z.string().regex(/^seg-\d{13}\.nrec$/) });

const permissionFlags = z
  .object({
    view: z.boolean(),
    control: z.boolean(),
    clipboard_in: z.boolean(),
    clipboard_out: z.boolean(),
    files: z.boolean(),
    audio: z.boolean(),
    record: z.boolean(),
    restart: z.boolean(),
    privacy_screen: z.boolean(),
    block_input: z.boolean(),
    shell: z.boolean(),
  })
  .strict();

/** POST /endpoints/:id/remote-desktop/participants: invite a colleague (never more than the session allows). */
export const participantInviteSchema = z.object({ user_id: z.uuid(), permissions: permissionFlags.optional() }).strict();
export type ParticipantInvite = z.infer<typeof participantInviteSchema>;

export const participantJoinSchema = z.object({ step_up_token: z.string().max(200).optional() }).strict();
export const participantParams = z.object({ id: z.uuid(), userId: z.uuid() });

/** POST /endpoints/:id/remote-desktop/wake: Wake-on-LAN, then the console connects when the agent is online. */
export const wakeCreateSchema = z
  .object({
    reason: z.string().trim().min(3, 'Give the reason for the session (at least 3 characters)').max(200),
    profile_id: z.uuid().optional(),
    timeout_s: z.number().int().min(60).max(1800).default(300),
  })
  .strict();
export type WakeCreate = z.infer<typeof wakeCreateSchema>;
export const wakeParams = z.object({ id: z.uuid(), wakeId: z.uuid() });

const fileName = z.string().trim().min(1).max(260);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

/** POST /endpoints/:id/remote-desktop/print: what was printed (name, size, hash; never the content). */
export const printAuditSchema = z
  .object({ name: fileName, bytes: z.number().int().min(0).max(1 << 30), sha256, mime: z.string().max(100) })
  .strict();
export type PrintAudit = z.infer<typeof printAuditSchema>;

/** POST /endpoints/:id/remote-desktop/transfer: a drag-and-drop or clipboard file transfer that finished. */
export const transferAuditSchema = z
  .object({
    direction: z.enum(['to_remote', 'from_remote']),
    via: z.enum(['drag_drop', 'clipboard', 'files_panel']),
    name: fileName,
    bytes: z.number().int().min(0).max(1 << 30),
    sha256,
  })
  .strict();
export type TransferAudit = z.infer<typeof transferAuditSchema>;

/** GET /fleet/sessions: remote support session history. */
export const sessionListQuery = z
  .object({
    endpoint_id: z.string().uuid().optional(),
    state: z.enum(['waiting_approval', 'waiting_consent', 'active', 'ended']).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
export type SessionListQuery = z.infer<typeof sessionListQuery>;
