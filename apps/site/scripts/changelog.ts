// Writes content/changelog.json from the git history (commit subjects; merge commits left out).
//
//   pnpm --filter @nigafiy/site changelog
//
// The site reads the committed file, so a shallow CI checkout builds the same page. Run this again
// before a release. Author names and e-mail addresses are not written.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, SITE_DIR } from '../lib/paths.ts';

const git = (...args: string[]) => execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();

const SEP = '\u001f';
const log = git('log', '--no-merges', `--format=%h${SEP}%cs${SEP}%s`);
const entries = log
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    const [hash = '', date = '', subject = ''] = line.split(SEP);
    return { hash, date, subject };
  });

const out = {
  source: {
    kind: 'git log --no-merges',
    branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
    head: git('rev-parse', '--short', 'HEAD'),
    generated_at: new Date().toISOString(),
  },
  entries,
};
const file = path.join(SITE_DIR, 'content', 'changelog.json');
writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
console.log(`[changelog] ${entries.length} commits from ${out.source.branch} @ ${out.source.head} → ${path.relative(REPO_ROOT, file)}`);
