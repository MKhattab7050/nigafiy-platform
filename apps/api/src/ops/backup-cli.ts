// Database backup / restore (pg_dump / pg_restore). Procedure: docs/operations/backup-restore-and-key-rotation.md.
import os from 'node:os';
import path from 'node:path';
import { backupDatabase, defaultBackupDir, OpsRefused, restoreDatabase } from './backup.ts';

const HELP = `Usage:
  pnpm --filter ./apps/api db:backup  [--out-dir <folder>] [--pg-bin <folder>]
  pnpm --filter ./apps/api db:restore --file <backup.dump> --confirm <database-name> [--force] [--pg-bin <folder>] [--maintenance-db <name>]

backup   Writes <database>-<YYYYMMDD-HHMMSS>Z.dump (pg_dump custom format) to --out-dir
         (default: <data folder>/backups, data folder = NIGAFIY_DATA_DIR (legacy LD_DATA_DIR) or <repo>/.data).
restore  Restores the file into a NEW database, checks it, then swaps it in by renaming; the previous
         database is kept as <name>_before_restore_<time>. Refuses while anything is connected to the
         database (stop the API / engine stack first) unless --force, which ends those sessions.
         --confirm must repeat the target database's name.

Connection: DATABASE_URL (owner) and APP_DATABASE_URL, from the environment or the repository .env.
Tools: pg_dump / pg_restore of at least the server's major version, from --pg-bin, NIGAFIY_PG_BIN_DIR,
next to the embedded PostgreSQL, on PATH, or the usual install folders.`;

type Command = 'backup' | 'restore';

interface Args {
  command: Command;
  outDir?: string;
  file?: string;
  confirm?: string;
  force: boolean;
  pgBin?: string;
  maintenanceDb?: string;
  help: boolean;
}

class UsageError extends Error {}

// Relative paths are taken from where the operator ran pnpm, not apps/api.
const userPath = (p: string) => path.resolve(process.env.INIT_CWD ?? process.cwd(), p);

function parseArgs(argv: readonly string[]): Args {
  const [command, ...rest] = argv;
  if (command !== 'backup' && command !== 'restore') throw new UsageError('first argument must be "backup" or "restore"');
  const args: Args = { command, force: false, help: false };
  for (let i = 0; i < rest.length; i++) {
    const raw = rest[i]!;
    if (raw === '--') continue;
    const [name, inline] = raw.includes('=') ? [raw.slice(0, raw.indexOf('=')), raw.slice(raw.indexOf('=') + 1)] : [raw, undefined];
    const value = () => {
      const v = inline ?? rest[++i];
      if (!v) throw new UsageError(`${name} needs a value`);
      return v;
    };
    if (name === '--help' || name === '-h') args.help = true;
    else if (name === '--pg-bin') args.pgBin = userPath(value());
    else if (command === 'backup' && name === '--out-dir') args.outDir = userPath(value());
    else if (command === 'restore' && name === '--file') args.file = userPath(value());
    else if (command === 'restore' && name === '--confirm') args.confirm = value();
    else if (command === 'restore' && name === '--force') args.force = true;
    else if (command === 'restore' && name === '--maintenance-db') args.maintenanceDb = value();
    else throw new UsageError(`unknown option for ${command}: ${name}`);
  }
  if (command === 'restore' && !args.help && !args.file) throw new UsageError('restore needs --file <backup.dump>');
  return args;
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${(err as Error).message}\n\n${HELP}`);
    return 2;
  }
  if (args.help) {
    console.log(HELP);
    return 0;
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is not set (the owner connection; it is read from the repository .env).');
    return 2;
  }
  const db = new URL(databaseUrl);
  const where = `database "${decodeURIComponent(db.pathname.slice(1))}" on ${db.hostname}:${db.port || 5432}`;
  try {
    if (args.command === 'backup') {
      console.log(`Backing up ${where} to ${args.outDir ?? defaultBackupDir()}`);
      const r = await backupDatabase({ databaseUrl, outDir: args.outDir, binDir: args.pgBin, log: (l) => console.log(l) });
      console.log(`Wrote ${r.file}`);
      console.log(`  ${mb(r.bytes)}, SHA-256 ${r.sha256}`);
      console.log('The backup holds sealed secrets: it can only be used with the APP_ENCRYPTION_KEY in effect today. Store the key separately.');
      return 0;
    }
    console.log(`Restoring ${args.file} into ${where}`);
    const r = await restoreDatabase({
      databaseUrl,
      appDatabaseUrl: process.env.APP_DATABASE_URL,
      file: args.file!,
      confirm: args.confirm,
      force: args.force,
      binDir: args.pgBin,
      maintenanceDb: args.maintenanceDb,
      operator: { osUser: os.userInfo().username, host: os.hostname() },
      log: (l) => console.log(l),
    });
    console.log(`Restored "${r.database}" (archive SHA-256 ${r.sha256}).`);
    if (r.terminatedSessions) console.log(`  Ended ${r.terminatedSessions} session(s).`);
    if (r.migrationsApplied.length) console.log(`  Applied ${r.migrationsApplied.length} newer migration(s).`);
    console.log(`  The previous database is kept as "${r.previousDatabase}". Once you are satisfied, drop it:`);
    console.log(`    DROP DATABASE "${r.previousDatabase}";`);
    console.log('Start the API with the APP_ENCRYPTION_KEY that was in effect when the backup was made.');
    return 0;
  } catch (err) {
    if (err instanceof OpsRefused) {
      console.error(`Refused: ${err.message}`);
      return 1;
    }
    console.error(`${args.command} failed: ${(err as Error).message}`);
    return 1;
  }
}

process.exitCode = await main();
