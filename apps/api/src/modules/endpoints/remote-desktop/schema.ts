import { z } from 'zod';

/** POST /endpoints/:id/remote-desktop/start */
export const rdStartSchema = z
  .object({
    display_index: z.number().int().min(0).max(8).default(0),
    quality: z.number().int().min(25).max(95).default(68),
    scale: z.number().min(0.25).max(1.0).default(0.75),
    // Nothing records sessions; asking for it is refused rather than silently ignored.
    recording_enabled: z.literal(false, { error: 'Session recording is not implemented' }).default(false),
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
    event_kind: z.enum(['mouse_move', 'mouse_click', 'mouse_down', 'mouse_up', 'mouse_wheel', 'key_press', 'text']),
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
  })
  .strict();

/** GET /fleet/sessions: remote support session history. */
export const sessionListQuery = z
  .object({
    endpoint_id: z.string().uuid().optional(),
    state: z.enum(['waiting_approval', 'waiting_consent', 'active', 'ended']).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
export type SessionListQuery = z.infer<typeof sessionListQuery>;
