import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Insight, InsightsReport } from '@nigafiy/shared-types';
import { MAX_STEPS, nextSteps } from './guidance-text.ts';

const insight = (id: string, code: string): Insight =>
  ({
    id,
    code,
    params: {},
    severity: 'info',
    category: 'availability',
    title: id,
    detail: '',
    evidence: [],
    actions: [{ id: 'go', kind: 'link', label: 'Go', href: '/' }],
  }) as unknown as Insight;

const report = (...insights: Insight[]) => ({ insights }) as unknown as InsightsReport;

describe('nextSteps', () => {
  it('asks to turn monitoring on once, not once per device and again for infrastructure', () => {
    const { steps, more } = nextSteps(
      report(
        insight('monitor-a', 'suggest_monitor'),
        insight('monitor-b', 'suggest_monitor'),
        insight('monitor-infrastructure', 'suggest_monitor_infrastructure'),
        insight('unreviewed', 'unreviewed'),
      ),
    );
    assert.deepEqual(
      steps.map((s) => s.insight.id),
      ['monitor-a', 'unreviewed'],
    );
    assert.equal(more, 2);
  });

  it('shows one "find the cause" step for several path problems', () => {
    const { steps } = nextSteps(report(insight('gw', 'path_gateway_down'), insight('dns', 'path_dns_degraded')));
    assert.deepEqual(
      steps.map((s) => s.insight.id),
      ['gw'],
    );
  });

  it('still stops at three steps and counts the rest', () => {
    const codes = ['unreviewed', 'collector_silent', 'critical_offline', 'open_incidents', 'ip_conflict'];
    const { steps, more } = nextSteps(report(...codes.map((c) => insight(c, c))));
    assert.equal(steps.length, MAX_STEPS);
    assert.equal(more, 2);
  });
});
