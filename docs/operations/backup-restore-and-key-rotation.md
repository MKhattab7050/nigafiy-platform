# Backup, Restore and Encryption-Key Rotation

Three operator tools ship with the API (`apps/api/src/ops/`). They run from a shell on the machine
that can reach the database, never from the web UI, and every run that changes data writes an audit
entry (`actor = 'system'`, `metadata.tool` names the tool, plus the operator's OS user and host).

| Command | What it does |
|---|---|
| `pnpm --filter ./apps/api db:backup` | `pg_dump` the database to a verified custom-format archive |
| `pnpm --filter ./apps/api db:restore --file <x.dump> --confirm <db>` | Restore into a **new** database, check it, then swap it in by renaming |
| `pnpm --filter ./apps/api rotate-key --new-key-file <path>` | Re-encrypt every sealed column from the old `APP_ENCRYPTION_KEY` to a new key, in one transaction |

All three read `DATABASE_URL` (owner connection) and `APP_DATABASE_URL` from the environment or the
repository `.env`. For the installed desktop app the `.env` lives in the data folder
(`%LOCALAPPDATA%\…\.env`, the folder `LD_DATA_DIR` points at): export its `DATABASE_URL`,
`APP_DATABASE_URL` and `APP_ENCRYPTION_KEY` into the shell first, or run the tools from a checkout
whose `.env` holds those values.

> **Always stop the API first** (or the Nigafiy engine stack / desktop app). The tools refuse to run
> while an API instance is connected, because a running API would keep writing with the old key or
> into the database being replaced. `--force` exists for the case where the connected sessions are
> not an API (e.g. a psql window), and for `db:restore` it ends those sessions.

---

## 1. Prerequisite: the PostgreSQL client tools (`pg_dump`, `pg_restore`)

**`embedded-postgres` does not bundle `pg_dump` or `pg_restore`.** The package used by the local
stack, the desktop app and the test suite contains only the server (`initdb`, `pg_ctl`,
`postgres`). The backup tool needs the client tools of **the same or a newer major version** than
the server (PostgreSQL 18 for the embedded server today; for an external server, check with
`SELECT current_setting('server_version_num')`).

Install them once:

- **Windows:** the EDB PostgreSQL installer (<https://www.postgresql.org/download/windows/>); in
  the component list select only **Command Line Tools**. They land in
  `C:\Program Files\PostgreSQL\<major>\bin`, which the tool finds by itself.
- **Debian / Ubuntu:** add the apt.postgresql.org repository, then
  `sudo apt install postgresql-client-18`.
- **RHEL / Fedora:** `sudo dnf install postgresql18` from the PGDG repository.
- **macOS:** `brew install postgresql@18`.

The tools are looked for, in this order, and the first one with a new enough version is used:

1. `--pg-bin <folder>` on the command line, or `NIGAFIY_PG_BIN_DIR` (legacy `LD_PG_BIN_DIR`) —
   when set, **only** this folder is used;
2. next to the embedded PostgreSQL binaries (in case a future package ships them);
3. every folder on `PATH`;
4. the usual install folders (`C:\Program Files\PostgreSQL\*\bin`, `/usr/lib/postgresql/*/bin`,
   `/usr/pgsql-*/bin`, Homebrew `postgresql@*`, Postgres.app).

If nothing suitable is found the tool stops with a message that lists what it found and how to fix
it; nothing is written.

## 2. Backup

```powershell
pnpm --filter ./apps/api db:backup                      # → <data folder>\backups\
pnpm --filter ./apps/api db:backup -- --out-dir D:\nigafiy-backups
```

- Writes `<database>-<YYYYMMDD-HHMMSS>Z.dump` (pg_dump **custom format**; compressed; restorable
  table by table). The data folder is `NIGAFIY_DATA_DIR`, then `LD_DATA_DIR`, else `<repo>\.data`.
- The archive is first written as `*.dump.partial`, read back with `pg_restore --list`, and only then
  renamed — a file without `.partial` is always a complete, readable archive.
- Prints the size and SHA-256 of the archive; keep the hash with the file.
- The API may keep running during a backup (pg_dump takes a consistent snapshot), but the
  quieter the better.
- Remote desktop screen images are never stored in the database (they pass through memory and
  PostgreSQL notifications only), so a backup never contains a screenshot of a user's screen.

**The backup contains sealed secrets** (router, SNMP, SSH, SMTP/webhook and MFA secrets, backed-up
device configurations). They can only be read with the `APP_ENCRYPTION_KEY` that was in effect when
the backup was made. Store the key **separately** from the backups (a password manager, a sealed
envelope), and keep every key for as long as you keep backups made with it.

## 3. Restore

```powershell
# 1. Stop the API / engine stack / desktop app.
# 2. Restore (the name after --confirm must be the target database's name):
pnpm --filter ./apps/api db:restore -- --file D:\nigafiy-backups\lan_detective-20261122-020000Z.dump --confirm lan_detective
# 3. Start the API with the APP_ENCRYPTION_KEY that was in effect when the backup was made.
```

What happens:

1. **Guards (nothing changed if any fails):** `--confirm` must repeat the database name; the file
   must exist and be a readable custom-format archive that contains `schema_migrations` (i.e. a
   Nigafiy / LAN Detective database); no session may be connected to the database (unless
   `--force`); the `lan_app` role is created from `APP_DATABASE_URL` if the server does not have it.
2. **Restore into a new database** `<name>_restoring_<time>` with `pg_restore --single-transaction
   --exit-on-error --no-owner`. If pg_restore fails, the half-restored database is dropped and the
   live one was never touched.
3. **Swap by renaming.** New connections to the live database are blocked, remaining sessions are
   refused (or ended with `--force`), then `<name>` → `<name>_before_restore_<time>` and
   `<name>_restoring_<time>` → `<name>`. PostgreSQL does not allow `ALTER DATABASE … RENAME` inside
   a transaction, so these are two statements: if the second fails, the first is undone (the
   original gets its name back and accepts connections again) and the tool reports it. If even the
   undo fails, the message gives the two SQL statements to put the original back by hand.
4. **Migrations** newer than the backup are applied (`APP_DATABASE_URL` must be set), and a
   `database.restored` audit entry (file name, SHA-256, previous database name) is written in every
   organization of the restored database.

The previous database is **kept** as `<name>_before_restore_<time>`. Once the restored data looks
right, drop it: `DROP DATABASE "<name>_before_restore_<time>";`

`--maintenance-db <name>` changes the database the tool connects to for CREATE/RENAME DATABASE
(default `postgres`). The owner role in `DATABASE_URL` needs `CREATEDB` (the embedded server's
`postgres` superuser has it).

### Embedded PostgreSQL vs external PostgreSQL

- **Embedded** (local stack, desktop app): start only the database (`pnpm --filter ./apps/api
  dev:db` for the development copy; for the desktop app quit the app, then start its PostgreSQL the
  same way with the app's data folder), or run the tools while the app is stopped but its database
  process is still up. Ports: 5433 (development), 47133 (installed app).
- **External**: point `DATABASE_URL` at it as usual. Managed services that forbid `CREATE
  DATABASE` / `ALTER DATABASE … RENAME` cannot use the swap; restore there with the provider's
  own tooling.

## 4. Rotating `APP_ENCRYPTION_KEY`

```powershell
# 1. Stop the API / engine stack / desktop app. Take a backup (section 2).
# 2. Create the new key in a file (never on the command line — it would land in shell history):
pnpm --filter ./apps/api rotate-key -- --generate-new-key-file D:\keys\new.key
# 3. Check first: every sealed value must decrypt with the current key. Changes nothing.
pnpm --filter ./apps/api rotate-key -- --new-key-file D:\keys\new.key --dry-run
# 4. Rotate:
pnpm --filter ./apps/api rotate-key -- --new-key-file D:\keys\new.key
# 5. Put the new key in .env as APP_ENCRYPTION_KEY, start the API, check a router / SNMP target /
#    e-mail channel still works, then delete the key file.
```

- The **old key** is `APP_ENCRYPTION_KEY` from the environment/`.env` unless `--old-key-file` or
  `NIGAFIY_OLD_ENCRYPTION_KEY` says otherwise; the new key comes from `--new-key-file` or
  `NIGAFIY_NEW_ENCRYPTION_KEY`. Keys are 64 hex characters. `--key`, `--old-key` and `--new-key`
  are rejected on purpose.
- Keys are never printed or logged; only a **key id** (first 12 hex digits of a SHA-256 over the
  key) is shown and audited, so you can tell which key a database was rotated to.
- **One transaction:** the sealed tables are locked against writes, every value is decrypted with
  the old key, re-encrypted with the new key, written back, read back and checked, and the audit
  entry `security.encryption_key_rotated` (counts per column, key ids, operator) is written — then
  COMMIT. Any failure rolls everything back.
- **Refusals (nothing changed):** same old and new key; an API connected (`--force` to override if
  the sessions are not an API); a value that does not decrypt with the old key (the message lists
  the table, column and row key — never the value — and says when the values already decrypt with
  the new key, i.e. the database was already rotated); a column that looks sealed (`*_enc`,
  `*_encrypted`, `*_sealed`) but is not in `apps/api/src/ops/sealed-columns.ts`, or a listed column
  missing (run migrations first).

The sealed columns (`apps/api/src/ops/sealed-columns.ts`):

| Table.column | Holds |
|---|---|
| `notification_channels.secret_encrypted` | webhook signing secret, SMTP password, Telegram / Slack / Discord / ntfy tokens and webhook URLs |
| `snmp_targets.secret_enc` | SNMP read credentials |
| `snmp_targets.write_secret_enc` | SNMP write credentials |
| `site_routers.secret_enc` | router login credentials |
| `users.mfa_secret_enc` | TOTP secret |
| `users.mfa_pending_secret_enc` | TOTP secret being set up |
| `config_backup_targets.secret_enc` | SSH credentials for configuration backups |
| `config_backup_contents.content_enc` | backed-up device configuration text |

When a migration adds a sealed column, add it to that list — the tool refuses to run otherwise.

**Old backups keep the old key.** A backup made before the rotation can only be restored and read
with the key that was in effect then. Restore it, then rotate it again if needed.

## 5. Where this is tested

`apps/api/tests/rotate-key.test.ts` (every sealed column, dry run, all refusals, audit),
`apps/api/tests/backup-restore.test.ts` (guards, the rename swap and its recovery, and — when the
PostgreSQL client tools are installed — backup, bad-archive refusal, end-to-end restore and a
failing pg_restore). The pg_dump/pg_restore tests are skipped, with a message saying so, on a
machine without the client tools.
