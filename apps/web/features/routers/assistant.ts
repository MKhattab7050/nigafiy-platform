/**
 * Router connection assistant (UX review 2026-11-26, item 13): the shapes of GET /router-assistant and
 * the pure rules the card follows. The API decides what the gateway is (only from observations);
 * this file only chooses which words and steps to show for that.
 *
 * Pure: no React, no DOM, so `node --test` can load it (assistant.test.ts).
 */

import type { assistantEn } from './assistant-strings.ts';

export type GuideId = 'zte_h188a' | 'huawei_dg8045' | 'zyxel' | 'other';
export type DetectionConfidence = 'high' | 'medium' | 'low' | 'none';
export type DriverMaturity = 'tested' | 'beta';
type AssistantKey = keyof typeof assistantEn;

export interface Detection {
  guide: GuideId;
  vendor: string | null;
  model: string | null;
  confidence: DetectionConfidence;
  evidence: { source: 'driver' | 'web_page' | 'upnp' | 'mac_vendor'; field: string; value: string; matched: string }[];
}

export interface AssistantGateway {
  address: string;
  collector: { id: string; name: string };
  device: { id: string; label: string; mac: string | null; vendor: string | null } | null;
  router: { id: string; name: string; vendor: string } | null;
  detection: Detection;
  maturity: DriverMaturity | null;
}

export interface AssistantView {
  site_id: string;
  gateways: AssistantGateway[];
  drivers: { vendor: string; maturity: DriverMaturity; tested_models: string[] }[];
}

/** Same rule as the API (apps/api/src/modules/routers/assistant.ts): only the Zyxel driver ran on real hardware, on the VMG3625-T50B. */
export const TESTED_MODELS: Readonly<Record<string, readonly string[]>> = { zyxel: ['VMG3625-T50B'] };

export function driverMaturity(vendor: string, model?: string | null): DriverMaturity {
  const tested = TESTED_MODELS[vendor];
  if (!tested?.length) return 'beta';
  if (!model) return 'tested';
  const m = model.toUpperCase().replace(/\s+/g, '');
  return tested.some((t) => m.includes(t.toUpperCase())) ? 'tested' : 'beta';
}

/** The sentence that says how sure the detection is: the strength of the observation, never more. */
export function confidenceKey(c: DetectionConfidence): AssistantKey {
  return `routers.assist.confidence.${c}` as AssistantKey;
}

/** Where the label with the web login is, for this model. */
export function stickerKey(guide: GuideId): AssistantKey {
  return `routers.assist.sticker.${guide}` as AssistantKey;
}

/** The steps, in order. Adding the router is the last step and is a button, not text. */
export function guideSteps(guide: GuideId): AssistantKey[] {
  return [stickerKey(guide), 'routers.assist.step.login', 'routers.assist.step.notWifi', 'routers.assist.step.add'];
}

/** The vendor the add-router wizard starts with: the detected one, when the observation named a vendor. */
export function wizardVendor(d: Detection): string | null {
  return d.confidence === 'none' ? null : d.vendor;
}

/**
 * The reset steps are shown only after the person confirms they have the internet (PPPoE) login,
 * because a reset erases it and most people do not have it.
 */
export function resetStepsVisible(hasPppoeLogin: boolean): boolean {
  return hasPppoeLogin === true;
}

export const RESET_STEPS: AssistantKey[] = ['routers.assist.reset.step1', 'routers.assist.reset.step2', 'routers.assist.reset.step3'];
