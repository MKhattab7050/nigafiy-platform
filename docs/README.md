# Nigafiy documentation

Start with [getting-started.md](getting-started.md) to run it, [architecture/flowcharts.md](architecture/flowcharts.md)
to see how it works, and [roadmap/status.md](roadmap/status.md) for what is built and what ran on real hardware.

## Getting started

- [getting-started.md](getting-started.md): prerequisites, the desktop app, `pnpm local`, the dev stack, every build and test command.

## Architecture

- [architecture/overview.md](architecture/overview.md): system overview, API module boundaries, four-layer tenant isolation, device identity, the monitoring state machine.
- [architecture/flowcharts.md](architecture/flowcharts.md): Mermaid diagrams of the real flows (ports, discovery, enrollment, remote desktop, router changes, restore, updates, distribution, sign-in).
- [architecture/database.md](architecture/database.md): PostgreSQL schema, migrations and time-series tables.
- [architecture/engine-sensor.md](architecture/engine-sensor.md): why the engine and the Sensor are one executable, `nigafiy-engine`, and how it runs the Sensor.
- [architecture/naming.md](architecture/naming.md): every renamed, kept and fallback identifier of the rename to Nigafiy, and the `check:brand` allow-list.
- [collector/protocol.md](collector/protocol.md): Sensor architecture and the collector protocol v1.
- [desktop/README.md](desktop/README.md): the desktop app, its local and remote-server modes, where it stores data.
- [desktop/engine.md](desktop/engine.md): `nigafiy-engine` commands, flags, supervision, restart policy, control API and Windows service.

## Features

- [features/capabilities.md](features/capabilities.md): what Nigafiy does today, area by area.
- [features/global-search.md](features/global-search.md): Hub global search across devices, endpoints, incidents, switches, subnets, routers and knowledge.
- [features/system-self-check.md](features/system-self-check.md): every API module and background job, with overdue and failing jobs.
- [features/user-guide.md](features/user-guide.md): the in-app user guide in English and Arabic.
- [features/sso.md](features/sso.md): OIDC and SAML 2.0 single sign-on per organization.
- [features/lan-tls.md](features/lan-tls.md): built-in CA and HTTPS listener for Sensors and Agents on other computers.
- [features/ipv6.md](features/ipv6.md): IPv6 discovery, addresses and IPAM.
- [features/neighbors-cdp-mndp.md](features/neighbors-cdp-mndp.md): LLDP, CDP, MikroTik neighbours and MNDP in Port Detective and Topology.
- [features/watch-checks.md](features/watch-checks.md): HTTP/HTTPS, TLS certificate expiry and SNMP OID checks.
- [features/smart-checks.md](features/smart-checks.md): rogue DHCP, UPnP, Wi-Fi analyser and fingerprinting checks run by the Sensor.
- [features/router-controls.md](features/router-controls.md): router controls beyond block/unblock, with the per-driver matrix and vendor sources.
- [features/switch-port-control.md](features/switch-port-control.md): enable/disable, VLAN and quarantine over SNMP SET.
- [features/config-backup.md](features/config-backup.md): SSH configuration backup, diff, sanitization, and Junos and IOS XE restore.
- [features/toolbox-scope.md](features/toolbox-scope.md): how every Toolbox target is checked against the authorized scopes.
- [features/playbooks.md](features/playbooks.md): approval-gated automation.
- [features/fleet-compliance.md](features/fleet-compliance.md): evidence-based compliance on Windows, Linux and macOS.
- [features/fleet-pro.md](features/fleet-pro.md): Fleet remote support and management: sessions, policy, tools, recording, shell, jobs, patches, WebRTC.

## Operations

- [operations/installers.md](operations/installers.md): NSIS, MSI and endpoint agent installers, program choice, silent and GPO installs.
- [operations/microsoft-store.md](operations/microsoft-store.md): MSIX packages for the Microsoft Store, research and owner steps.
- [operations/code-signing.md](operations/code-signing.md): free Authenticode signing with a self-signed certificate deployed by GPO.
- [operations/updates.md](operations/updates.md): Ed25519-signed manifest, download, verification and admin-confirmed install.
- [operations/backup-restore-and-key-rotation.md](operations/backup-restore-and-key-rotation.md): database backup and restore, `APP_ENCRYPTION_KEY` rotation.
- [operations/real-hardware-checklist.md](operations/real-hardware-checklist.md): what the owner still has to run on real hardware (one PC, two PCs, phone, router, other gear, a real fault).

## Security

- [security/model.md](security/model.md): every security control and where it is implemented, what is not implemented yet, what is deliberately absent.
- [../SECURITY.md](../SECURITY.md): how to report a vulnerability.

## Roadmap

- [roadmap/status.md](roadmap/status.md): what is built, what ran on real hardware versus tests only, gates, open gaps, risks.

## Design

- [design/mockups/README.md](design/mockups/README.md): the design mockups (`*.dc.html`) and what each artboard decides.

## Plans and specs

History of how the platform was planned; [roadmap/status.md](roadmap/status.md) wins where they differ.

- [superpowers/specs/2026-11-21-nigafiy-platform-design.md](superpowers/specs/2026-11-21-nigafiy-platform-design.md): the platform design: program family, feature map, architecture.
- [superpowers/specs/2026-11-21-nigafiy-handoff-prompt.md](superpowers/specs/2026-11-21-nigafiy-handoff-prompt.md): the handoff prompt for the restructuring (Arabic).
- [superpowers/specs/2026-11-21-router-controls-handoff.md](superpowers/specs/2026-11-21-router-controls-handoff.md): handoff for router and device controls.
- [superpowers/plans/2026-11-21-nigafiy-implementation.md](superpowers/plans/2026-11-21-nigafiy-implementation.md): master implementation plan.
- [superpowers/plans/2026-11-21-nigafiy-hardening-and-routers.md](superpowers/plans/2026-11-21-nigafiy-hardening-and-routers.md): hardening, AI removal and multi-vendor routers.
- [superpowers/plans/2026-11-21-nigafiy-m2-rename.md](superpowers/plans/2026-11-21-nigafiy-m2-rename.md): Milestone 2, rename and brand.
- [superpowers/plans/2026-11-21-nigafiy-m3-engine-hub.md](superpowers/plans/2026-11-21-nigafiy-m3-engine-hub.md): Milestone 3, engine service and Hub.
- [superpowers/plans/2026-11-21-nigafiy-m4-programs.md](superpowers/plans/2026-11-21-nigafiy-m4-programs.md): Milestone 4, the seven programs.
- [superpowers/plans/2026-11-22-nigafiy-m4b-fleet-pro.md](superpowers/plans/2026-11-22-nigafiy-m4b-fleet-pro.md): Milestone 4b, Fleet Pro.
