// rotate-key: re-encrypts every sealed column from the old APP_ENCRYPTION_KEY to a new one in one
// transaction. Usage and procedure: docs/operations/backup-restore-and-key-rotation.md.
//
// Keys are never accepted as command-line values (they would land in shell history and the process
// list): they come from files (--old-key-file / --new-key-file) or environment variables.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { keyId, parseKeyHex } from '../common/secret-box.ts';
import { RotationRefused, rotateEncryptionKey } from './rotate-key.ts';

const HELP = `Usage: pnpm --filter ./apps/api rotate-key [options]

Re-encrypts every sealed column (router, SNMP, SMTP/webhook, config-backup and MFA secrets, backed-up
configurations) from the old APP_ENCRYPTION_KEY to a new key, in one transaction. Stop the API first.

Options:
  --new-key-file <path>           File holding the new key (64 hex characters). Or set NIGAFIY_NEW_ENCRYPTION_KEY.
  --old-key-file <path>           File holding the old key. Or set NIGAFIY_OLD_ENCRYPTION_KEY.
                                  Default: APP_ENCRYPTION_KEY from the environment / .env.
  --generate-new-key-file <path>  Write a fresh random key to <path> (must not exist) and exit.
  --dry-run                       Check that every value decrypts with the old key; change nothing.
  --force                         Rotate even though API sessions are connected (not recommended).
  --help                          This text.

Needs DATABASE_URL (the owner connection), read from the environment or the repository .env.
Keys are never printed; only a short key id (a hash prefix) is shown.`;

interface Args {
  newKeyFile?: string;
  oldKeyFile?: string;
  generate?: string;
  dryRun: boolean;
  force: boolean;
  help: boolean;
}

class UsageError extends Error {}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { dryRun: false, force: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!;
    if (raw === '--') continue;
    const [name, inline] = raw.includes('=') ? [raw.slice(0, raw.indexOf('=')), raw.slice(raw.indexOf('=') + 1)] : [raw, undefined];
    const value = () => {
      const v = inline ?? argv[++i];
      if (!v) throw new UsageError(`${name} needs a value`);
      return v;
    };
    switch (name) {
      case '--new-key-file':
        args.newKeyFile = value();
        break;
      case '--old-key-file':
        args.oldKeyFile = value();
        break;
      case '--generate-new-key-file':
        args.generate = value();
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--force':
        args.force = true;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      case '--key':
      case '--old-key':
      case '--new-key':
        throw new UsageError(`${name} is not accepted: a key on the command line ends up in shell history. Use ${name}-file <path> or the environment variable instead.`);
      default:
        throw new UsageError(`unknown option ${name}`);
    }
  }
  return args;
}

// Relative paths are taken from where the operator ran pnpm, not apps/api.
const userPath = (p: string) => path.resolve(process.env.INIT_CWD ?? process.cwd(), p);

function readKeyFile(file: string, label: string): Buffer {
  const resolved = userPath(file);
  if (!existsSync(resolved)) throw new UsageError(`${label} file not found: ${resolved}`);
  if (statSync(resolved).size > 1024) throw new UsageError(`${label} file is too large to be a key file: ${resolved}`);
  return parseKeyHex(readFileSync(resolved, 'utf8'), `${label} (${resolved})`);
}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`rotate-key: ${(err as Error).message}\n\n${HELP}`);
    return 2;
  }
  if (args.help) {
    console.log(HELP);
    return 0;
  }

  if (args.generate) {
    const target = userPath(args.generate);
    if (existsSync(target)) {
      console.error(`rotate-key: ${target} already exists; refusing to overwrite it.`);
      return 2;
    }
    const key = randomBytes(32);
    writeFileSync(target, `${key.toString('hex')}\n`, { mode: 0o600, flag: 'wx' });
    console.log(`Wrote a new key to ${target} (key id ${keyId(key)}). Keep this file private; delete it once the key is in .env.`);
    return 0;
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('rotate-key: DATABASE_URL is not set (the owner connection; it is read from the repository .env).');
    return 2;
  }

  let oldKey: Buffer;
  let newKey: Buffer;
  try {
    if (args.oldKeyFile) oldKey = readKeyFile(args.oldKeyFile, 'old key');
    else if (process.env.NIGAFIY_OLD_ENCRYPTION_KEY) oldKey = parseKeyHex(process.env.NIGAFIY_OLD_ENCRYPTION_KEY, 'NIGAFIY_OLD_ENCRYPTION_KEY');
    else if (process.env.APP_ENCRYPTION_KEY) oldKey = parseKeyHex(process.env.APP_ENCRYPTION_KEY, 'APP_ENCRYPTION_KEY');
    else throw new UsageError('no old key: pass --old-key-file, or set NIGAFIY_OLD_ENCRYPTION_KEY or APP_ENCRYPTION_KEY');

    if (args.newKeyFile) newKey = readKeyFile(args.newKeyFile, 'new key');
    else if (process.env.NIGAFIY_NEW_ENCRYPTION_KEY) newKey = parseKeyHex(process.env.NIGAFIY_NEW_ENCRYPTION_KEY, 'NIGAFIY_NEW_ENCRYPTION_KEY');
    else throw new UsageError('no new key: pass --new-key-file <path> (see --generate-new-key-file) or set NIGAFIY_NEW_ENCRYPTION_KEY');
  } catch (err) {
    console.error(`rotate-key: ${(err as Error).message}`);
    return 2;
  }

  const db = new URL(databaseUrl);
  console.log(`${args.dryRun ? 'Checking' : 'Rotating'} sealed values in database "${db.pathname.slice(1)}" on ${db.hostname}:${db.port || 5432}`);
  console.log(`  old key id ${keyId(oldKey)} → new key id ${keyId(newKey)}`);
  try {
    const result = await rotateEncryptionKey({
      databaseUrl,
      oldKey,
      newKey,
      dryRun: args.dryRun,
      force: args.force,
      operator: { osUser: os.userInfo().username, host: os.hostname() },
      log: (line) => console.log(line),
    });
    if (result.dryRun) {
      console.log(`Dry run: all ${result.total} sealed value(s) decrypt with the old key. Nothing was changed.`);
      return 0;
    }
    console.log(`Rotated ${result.total} sealed value(s) in one transaction; ${result.auditRows} audit entr${result.auditRows === 1 ? 'y' : 'ies'} written.`);
    console.log('');
    console.log('Next, before starting the API again:');
    console.log(`  1. Set APP_ENCRYPTION_KEY in the .env to the new key (key id ${result.newKeyId}).`);
    console.log('  2. Start the API (or the Nigafiy engine stack) and check a router/SNMP/e-mail channel still works.');
    console.log('  3. Delete the key files. Keep the OLD key as long as you keep database backups made before today.');
    return 0;
  } catch (err) {
    if (err instanceof RotationRefused) {
      console.error(`rotate-key refused: ${err.message}`);
      return 1;
    }
    // Database and I/O errors: the transaction was rolled back. Their messages carry no secret values.
    console.error(`rotate-key failed, nothing was changed: ${(err as Error).message}`);
    return 1;
  }
}

process.exitCode = await main();
