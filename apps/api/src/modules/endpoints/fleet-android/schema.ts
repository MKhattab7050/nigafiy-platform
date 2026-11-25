import { z } from 'zod';

// Android phones as Fleet endpoints (docs/features/android.md, migration 045).

const reason = z.string().trim().min(3).max(200);
const stepUpToken = z.string().max(200).optional();

/** POST /endpoints/:id/android/actions */
export const androidActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('lock'), step_up_token: stepUpToken }).strict(),
  z.object({ action: z.literal('password_policy'), complexity: z.enum(['none', 'low', 'medium', 'high']), step_up_token: stepUpToken }).strict(),
  z.object({ action: z.literal('camera'), disabled: z.boolean(), step_up_token: stepUpToken }).strict(),
  z.object({ action: z.literal('install_apk'), apk_id: z.uuid(), step_up_token: stepUpToken }).strict(),
  z
    .object({
      action: z.literal('uninstall'),
      package: z.string().max(200).regex(/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/, 'must be an Android package name such as com.example.app'),
      step_up_token: stepUpToken,
    })
    .strict(),
  z.object({ action: z.literal('wipe'), reason, step_up_token: stepUpToken }).strict(),
  z.object({ action: z.literal('release'), reason, step_up_token: stepUpToken }).strict(),
  // Regular app mode is enough (the phone reports the "ring" feature).
  z.object({ action: z.literal('ring'), seconds: z.number().int().min(5).max(120).default(30), step_up_token: stepUpToken }).strict(),
  z.object({ action: z.literal('ring_stop'), step_up_token: stepUpToken }).strict(),
]);
export type AndroidAction = z.infer<typeof androidActionSchema>;

/** GET /fleet/android/requests */
export const androidRequestListQuery = z.object({
  state: z.enum(['pending', 'decided']).default('pending'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** POST /fleet/android/requests/:id/approve | deny */
export const androidRequestDecisionSchema = z.object({ note: z.string().trim().max(300).optional() }).strict();

/** POST /fleet/android/apks?name=&file_name= (body: the APK bytes) */
export const apkUploadQuery = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(120)
    // eslint-disable-next-line no-control-regex
    .regex(/^[^\u0000-\u001f\u007f]*$/, 'control characters are not allowed'),
  file_name: z
    .string()
    .trim()
    .min(5)
    .max(200)
    .regex(/^[A-Za-z0-9][A-Za-z0-9 ._()-]*\.apk$/i, 'must be a plain file name ending in .apk'),
});
