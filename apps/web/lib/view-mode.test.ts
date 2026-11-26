import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { DEFAULT_VIEW, dashboardWidgets, parseView, programHasPages, shownIn, sidebarSections } from './view-mode.ts';

// The simple (Home) view, UX review 2026-11-26 item 7. registry.tsx imports React components, so its
// entries are read from the source text: each top-level `{ id: '…'` up to the next one.
const source = readFileSync(new URL('../features/registry.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const list = source.slice(source.indexOf('export const FEATURES'), source.indexOf('\n];'));
const starts = [...list.matchAll(/\n {2}\{\s*id: '([^']+)'/g)];
const features = starts.map((m, i) => {
  const chunk = list.slice(m.index, starts[i + 1]?.index ?? list.length);
  const widgetLine = /widget: \{[^\n]*\}/.exec(chunk)?.[0];
  const own = widgetLine ? chunk.replace(widgetLine, '') : chunk;
  return {
    id: m[1]!,
    program: /program: '(\w+)'/.exec(chunk)![1]!,
    route: /route: '([^']+)'/.exec(chunk)![1]!,
    home: /\bhome: true\b/.test(own),
    widget: widgetLine ? { home: /\bhome: true\b/.test(widgetLine) } : undefined,
  };
});
const ids = (xs: readonly { id: string }[]) => xs.map((f) => f.id).sort();
const never = () => false;

/** Pages a home needs: they stay in the simple view's sidebar. */
const CORE = ['dashboard', 'settings', 'sensors', 'devices', 'discovery', 'topology', 'monitoring', 'incidents', 'events', 'doctor', 'security', 'access', 'routers'];
/** Office and admin pages the simple view hides (they stay in the full view). */
const HIDDEN = ['ipam', 'ports', 'port-control', 'config-backup', 'portfolio', 'programs', 'insights', 'time-machine', 'impact', 'reports', 'maintenance', 'subnet', 'knowledge', 'playbooks', 'automation', 'endpoints', 'fleet-sessions', 'fleet-requests', 'fleet-policies', 'fleet-approvals', 'fleet-scripts', 'fleet-jobs', 'fleet-patches', 'fleet-monitoring'];

describe('simple / full view', () => {
  it('reads the registry', () => {
    assert.ok(features.length > 30, `only ${features.length} features found`);
    for (const id of [...CORE, ...HIDDEN]) assert.ok(features.some((f) => f.id === id), `${id} is not in the registry`);
  });

  it('defaults to the full view and ignores unknown stored values', () => {
    assert.equal(DEFAULT_VIEW, 'full');
    assert.equal(parseView(null), 'full');
    assert.equal(parseView('simple'), 'full');
    assert.equal(parseView('home'), 'home');
    assert.equal(parseView('full'), 'full');
  });

  it('the full view shows every page and every widget', () => {
    assert.deepEqual(ids(sidebarSections(features, 'full', never)), ids(features));
    assert.deepEqual(ids(dashboardWidgets(features, 'full')), ids(features.filter((f) => f.widget)));
  });

  it('the simple view keeps the core pages and hides the office ones', () => {
    const shown = new Set(ids(sidebarSections(features, 'home', never)));
    for (const id of CORE) assert.ok(shown.has(id), `${id} should stay in the simple view`);
    for (const id of HIDDEN) assert.ok(!shown.has(id), `${id} should be hidden in the simple view`);
  });

  it('Watch collapses to a few pages', () => {
    const watch = features.filter((f) => f.program === 'watch');
    const kept = sidebarSections(watch, 'home', never);
    assert.ok(watch.length >= 10 && kept.length <= 5, `${kept.length} of ${watch.length} Watch pages kept`);
  });

  it('a hidden page keeps its link while it is the page shown', () => {
    const ipam = features.find((f) => f.id === 'ipam')!;
    const shown = sidebarSections(features, 'home', (route) => route === ipam.route);
    assert.ok(shown.some((f) => f.id === 'ipam'));
    assert.equal(shownIn(ipam, 'home'), false);
    assert.equal(shownIn(ipam, 'full'), true);
  });

  it('the simple dashboard draws about six widgets, none of them office-only', () => {
    const kept = ids(dashboardWidgets(features, 'home'));
    assert.ok(kept.length >= 5 && kept.length <= 8, `${kept.length} widgets: ${kept.join(', ')}`);
    for (const id of ['incidents', 'devices', 'monitoring', 'doctor']) assert.ok(kept.includes(id), `${id} widget missing`);
    for (const id of ['ipam', 'ports', 'config-backup', 'endpoints', 'playbooks', 'knowledge', 'portfolio']) assert.ok(!kept.includes(id), `${id} widget should be hidden`);
  });

  it('programs with no simple page leave the program switcher', () => {
    const of = (program: string) => features.filter((f) => f.program === program);
    assert.equal(programHasPages(of('fleet'), 'home'), false);
    assert.equal(programHasPages(of('mind'), 'home'), false);
    assert.equal(programHasPages(of('radar'), 'home'), true);
    assert.equal(programHasPages(of('fleet'), 'full'), true);
  });
});
