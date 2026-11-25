# Security policy

## Reporting a vulnerability

This repository is private. Report a vulnerability **privately**; never in a public issue, pull
request, chat or commit message.

1. Use GitHub's private vulnerability reporting for this repository (**Security → Report a
   vulnerability**), or, if it is not enabled, contact the repository owner directly through GitHub.
2. Include what is affected (program, component and version or commit), how to reproduce it, and what
   an attacker gains. Do not attach real credentials, tokens, customer data or captures from a real
   network.
3. You get an acknowledgement, then a fix or a decision, in that private thread.

Please do not test against anyone's real network, router or device, and do not run destructive tests
against an installation you do not own.

## Supported versions

Nigafiy has no public release yet (version `1.0.3` is an internal release, installed only inside the owner's company). Security fixes go to the active
development branch; there are no maintained older versions.

| Version | Supported |
| --- | --- |
| Development branch (`main` once pushed) | Yes |
| Anything else | No |

## What is in scope

Every component in this repository: the API (`apps/api`), the web console (`apps/web`), the desktop app
(`apps/desktop`), the engine (`engine`), the Sensor (`collectors/lan-collector`), the Agent and Quick
Support (`agents/endpoint-agent`), the installers and the update and signing scripts (`scripts`).

## How Nigafiy is secured

The security controls, what is not implemented yet and what is deliberately absent are in
[docs/security/model.md](docs/security/model.md). Related: [docs/features/sso.md](docs/features/sso.md),
[docs/features/lan-tls.md](docs/features/lan-tls.md),
[docs/operations/updates.md](docs/operations/updates.md),
[docs/operations/code-signing.md](docs/operations/code-signing.md) and
[docs/operations/backup-restore-and-key-rotation.md](docs/operations/backup-restore-and-key-rotation.md).
No independent security review or penetration test has been done yet.
