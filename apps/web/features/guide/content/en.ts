// The Nigafiy user guide in English. Written for an office administrator, not a network engineer.
// Every statement here describes what the code does today; what has not been tried on real
// hardware says so. The Arabic guide (ar.ts) has the same sections, anchors and links (guide.test.ts).
import type { GuideContent } from '../types.ts';

export const GUIDE_EN: GuideContent = [
  {
    id: 'start-here',
    group: 'start',
    program: null,
    title: 'Start here',
    summary: 'Install Nigafiy on a Windows computer, see the devices on your network, and get alerts on your phone. No technical knowledge needed.',
    blocks: [
      {
        kind: 'p',
        text: 'Nigafiy runs on one Windows 10 or 11 computer in your home or office. It finds the devices on your network, tells you when something new joins or something stops working, and keeps everything on that computer. Four short steps get you there.',
      },
      { kind: 'h', id: 'install', text: '1. Install it' },
      {
        kind: 'steps',
        items: [
          'On the computer that stays on most of the time, open the Nigafiy downloads page and download the setup program (`Nigafiy Setup <version>.exe`).',
          'Open the downloaded file. If Windows shows a blue “Windows protected your PC” window, choose More info, check that the file name is the Nigafiy setup program, then choose Run anyway. The downloads page shows pictures of these windows.',
          'If Windows then asks whether to allow an app from an “Unknown publisher” to make changes, choose Yes only if you downloaded the file from the Nigafiy downloads page yourself.',
          'Follow the setup and choose Finish. Nigafiy opens and signs you in on this computer by itself.',
        ],
      },
      {
        kind: 'note',
        tone: 'info',
        text: 'Nigafiy starts by itself when you sign in to Windows and waits in the tray (the small icons near the clock). To open it, select its tray icon. You can turn this off from the tray menu.',
      },
      {
        kind: 'note',
        tone: 'warn',
        text: 'Those Windows warnings appear because the setup program is not signed with a certificate Windows already trusts. They do not mean the file is harmful, but only run a file you downloaded from the Nigafiy downloads page. To be sure the file was not changed, compare its SHA-256 with the one on the downloads page (see “Check a download” there).',
      },
      { kind: 'h', id: 'password', text: '2. Set your own password' },
      {
        kind: 'p',
        text: 'Nigafiy offers “Set your own password” the first time it opens (you can also find it in Settings). Choose a password you will remember and save the recovery codes it shows on paper or in a password manager. With that password you can open Nigafiy from your phone or another browser, and you keep access if Windows is reinstalled.',
      },
      { kind: 'h', id: 'scan', text: '3. See your devices' },
      {
        kind: 'steps',
        items: [
          'On the Hub dashboard, follow the setup card. It installs the Sensor (the part that looks at the network) on this computer.',
          'When the card asks, confirm the network range it suggests, for example `192.168.1.0/24`. Nigafiy only looks at networks you confirm.',
          'Wait a minute. Your devices appear in Radar, Devices. Give the ones you know a name, so a new one stands out.',
        ],
      },
      {
        kind: 'p',
        text: 'Phones often stay quiet while they are locked, so they may appear a little later. The section “Your first network scan” explains each step in more detail.',
      },
      { kind: 'h', id: 'phone', text: '4. Get alerts on your phone' },
      {
        kind: 'steps',
        items: [
          'Install the free ntfy app on your phone (Android or iPhone) and subscribe to a topic with a long, hard-to-guess name.',
          'In Nigafiy, open Watch, Notifications, add an ntfy channel and type the same topic name.',
          'Choose Send test. When it arrives on your phone, you will get alerts there too.',
        ],
      },
      {
        kind: 'p',
        text: 'You can also get alerts by Telegram or email from the same page. To open Nigafiy itself from your phone while you are at home, use the phone card on the Hub dashboard: it shows the address to open on a phone connected to the same Wi-Fi.',
      },
      {
        kind: 'note',
        tone: 'warn',
        text: 'Nigafiy watches your network only while that computer is on. If it is off or asleep, nothing is checked and no alerts are sent; when it comes back, Nigafiy shows that monitoring was off for that time.',
      },
    ],
    links: [
      { href: '/', label: 'Hub dashboard' },
      { href: '/radar/devices', label: 'Devices' },
      { href: '/watch/notifications', label: 'Notifications' },
    ],
  },
  {
    id: 'getting-started',
    group: 'start',
    program: null,
    title: 'Getting started',
    summary: 'Your first sign-in, how the screen is laid out, sites, and who can do what.',
    blocks: [
      { kind: 'h', id: 'first-sign-in', text: 'Your first sign-in' },
      {
        kind: 'p',
        text: 'Nigafiy runs on your own computer or server; your network data stays there. The first person to open it creates the organization and becomes its owner.',
      },
      {
        kind: 'steps',
        items: [
          'Open Nigafiy. If no account exists yet, choose Create account.',
          'Type your work email and a password of at least 10 characters.',
          'Your name, the organization name and the first site are filled in for you under More options. You can change all of them later.',
          'Choose Create account. You land on the Hub dashboard.',
        ],
      },
      {
        kind: 'p',
        text: 'If someone already set Nigafiy up, ask them for an invitation link instead. Some servers turn self-service registration off; the page then says so.',
      },
      {
        kind: 'note',
        tone: 'info',
        text: 'Forgot your password? Choose Forgot password? on the sign-in page. If outgoing email is set up you receive a reset link; otherwise an administrator can make a reset link for you in Settings, under Team & Organization Security.',
      },
      { kind: 'h', id: 'layout', text: 'Finding your way around' },
      {
        kind: 'list',
        items: [
          'Top bar, the same on every page: the site selector, search, the summary report, the Live indicator, light or dark theme, the language button, and the help button (the question mark), which opens this guide at the part that explains the page you are on.',
          'Sidebar: the program switcher at the top, then the pages of the program you are in. At the bottom: Settings, your organization and role, User guide and Sign out.',
          'On a phone or a small window the sidebar opens from the menu button in the top bar.',
        ],
      },
      { kind: 'h', id: 'sites', text: 'Sites' },
      {
        kind: 'p',
        text: 'A site is one physical location, such as a head office or a branch. Each site needs its own Sensor (see "Your first network scan"). The site selector in the top bar narrows every page to one site; All sites shows everything.',
      },
      { kind: 'h', id: 'roles', text: 'Team members and roles' },
      {
        kind: 'p',
        text: 'Invite colleagues from Settings, under Team & Organization Security: choose Send invitation and share the link it shows. Each member has one role:',
      },
      {
        kind: 'table',
        head: ['Role', 'What it can do'],
        rows: [
          ['Owner', 'Everything, including the organization itself.'],
          ['Admin', 'Everything a technician can, plus settings, team members, router changes, access policies and approvals.'],
          ['Technician', 'Everyday work: reviewing devices, checks, toolbox runs, enrolling computers and remote sessions where the access policy allows.'],
          ['Viewer', 'Reads what it is allowed to see. Pages show no change buttons to a viewer.'],
        ],
      },
      {
        kind: 'p',
        text: 'Under Organization MFA policy an administrator can require two-factor sign-in for administrators or for everyone. Every member can turn on two-factor sign-in for their own account in Settings.',
      },
    ],
    links: [
      { href: '/', label: 'Hub dashboard' },
      { href: '/settings', label: 'Settings' },
    ],
  },
  {
    id: 'programs',
    group: 'start',
    program: null,
    title: 'The seven programs',
    summary: 'What each Nigafiy program is for, and how programs are added or left out.',
    blocks: [
      {
        kind: 'p',
        text: 'Nigafiy is one engine with seven programs. Each program has its own colour and its own pages in the sidebar. Move between them with the program switcher at the top of the sidebar.',
      },
      {
        kind: 'table',
        head: ['Program', 'What it is for'],
        rows: [
          ['Nigafiy Hub', 'Home: the dashboard, all sites, Sensors, programs, settings and the engine.'],
          ['Nigafiy Radar', 'See every device on the network: devices, discovery, network map, IP addresses, switch ports.'],
          ['Nigafiy Watch', 'Monitor, and understand what went wrong: checks, incidents, events, Network Doctor, reports, notifications.'],
          ['Nigafiy Guard', 'Protect and control the network: smart checks, access control, routers, switch port control, config backup.'],
          ['Nigafiy Fleet', 'Manage and support company computers that run the Nigafiy agent.'],
          ['Nigafiy Mind', 'Knowledge, playbooks and automation.'],
          ['Nigafiy Toolbox', 'Quick network tools: ping, traceroute, port checks, DNS, subnet calculator.'],
        ],
      },
      {
        kind: 'p',
        text: 'Fleet Pro is not an eighth program. It is the professional remote-support part of Nigafiy Fleet: remote sessions, help requests, Quick Support, access policies, approvals, scripts, jobs, patches and monitoring rules.',
      },
      { kind: 'h', id: 'on-off', text: 'Adding a program or leaving one out' },
      {
        kind: 'p',
        text: 'The Hub page Programs lists every program and whether this installation offers it. Which programs are installed is chosen when Nigafiy is installed: the installer has a page to choose them. There is no on/off switch inside the app.',
      },
      {
        kind: 'list',
        items: [
          'To add a program, run the Nigafiy installer again and choose it.',
          'For a silent install the choice is `/PROGRAMS=radar,watch` (the setup program) or `PROGRAMS=` (the MSI package). On a server it is the `NIGAFIY_PROGRAMS` setting.',
          'Nigafiy Hub is always installed.',
          'A program that is left out still collects its data; only its pages are not offered. Where another program would link to it, you see "Available in Nigafiy …: Install", which leads to the Programs page.',
        ],
      },
      { kind: 'h', id: 'install-update', text: 'How Nigafiy is installed and updated' },
      {
        kind: 'table',
        head: ['Installed from', 'How it is updated'],
        rows: [
          ['Microsoft Store', 'The Microsoft Store updates it. The update card on the Hub dashboard says so and offers no in-app update. Store apps never show the “Windows protected your PC” warning.'],
          ['MSI package, deployed by Group Policy or Intune', 'Your administrator publishes the newer MSI the same way. The in-app updater does not install over it.'],
          ['Nigafiy setup program (.exe)', 'The update card on the Hub dashboard downloads the update, checks its signature and installs it when you ask. A downloaded setup that is not signed with a trusted certificate shows a Windows warning first.'],
        ],
      },
      {
        kind: 'p',
        text: 'The Store version and the setup-program version of the desktop app cannot run at the same time on one computer; each keeps its own data. The computer agent for Fleet is not in the Store: it comes as its own setup program, usually deployed by Group Policy (see "Add a computer to Fleet").',
      },
      {
        kind: 'note',
        tone: 'info',
        text: 'The engine and the Sensor are one program, `nigafiy-engine.exe`. After an update from an older setup program or MSI, Windows may ask once whether `nigafiy-engine.exe` may accept connections. Allow it on private networks, so the Sensor can hear MikroTik announcements and, if you turned it on, answer as the DNS filter. The Sensor keeps its enrollment.',
      },
      {
        kind: 'note',
        tone: 'warn',
        text: 'The Microsoft Store packages have been built and inspected, but they are not published yet and have not been installed on a real computer. Until the Store listing exists, install with the setup program or the MSI.',
      },
      {
        kind: 'note',
        tone: 'info',
        text: 'In this guide, the sections about a program that is not installed here are marked "Not installed". You can still read them.',
      },
    ],
    links: [{ href: '/programs', label: 'Programs' }],
  },
  {
    id: 'first-scan',
    group: 'tasks',
    program: null,
    title: 'Your first network scan',
    summary: 'Install a Sensor, authorize your network range, and scan.',
    blocks: [
      {
        kind: 'p',
        text: 'Nigafiy only looks at networks you explicitly authorize. The looking is done by a Sensor (also called a collector): a small program on a computer inside the office network. Nothing is probed until an administrator authorizes a range.',
      },
      { kind: 'h', id: 'sensor', text: '1. Install a Sensor' },
      {
        kind: 'p',
        text: 'The desktop app includes a Sensor, and its first-run setup can enroll it on the same computer. To put a Sensor on another computer:',
      },
      {
        kind: 'steps',
        items: [
          'Open Hub, Sensors (or Radar, Discovery) and choose Add collector. Give it a name, for example the room it sits in.',
          'Nigafiy shows an enrollment token and the install commands: Docker on a Linux computer, the program file, or this computer. The token works once, expires in 24 hours and is shown only once.',
          'Run the command on that computer. When the Sensor checks in, its state changes to Reporting.',
        ],
      },
      {
        kind: 'p',
        text: 'The program file is `nigafiy-engine`, the same program that runs the engine. On a computer that only scans, it runs as `nigafiy-engine sensor`. A Sensor installed before this version keeps working and keeps its enrollment.',
      },
      { kind: 'h', id: 'scope', text: '2. Authorize the range' },
      {
        kind: 'steps',
        items: [
          'In Radar, Discovery, choose Authorize a range.',
          'Type the range, for example `192.168.1.0/24`, and an optional label.',
          'Tick the box that confirms your organization owns this network or is allowed to monitor it, and save.',
        ],
      },
      {
        kind: 'list',
        items: [
          'Only private IPv4 ranges are accepted: `10.0.0.0/8`, `172.16.0.0/12` and `192.168.0.0/16`, each authorized range no larger than `/20` (4,096 addresses).',
          'IPv6 LAN prefixes are accepted up to `/48`. Only prefixes of `/120` or smaller are tried address by address; for larger ones the Sensor reads its neighbour table instead.',
        ],
      },
      { kind: 'h', id: 'scan', text: '3. Scan' },
      {
        kind: 'p',
        text: 'Choose Scan now. The scan starts at the Sensor’s next check-in, within about 30 seconds. After that the Sensor scans again on its own every discovery interval (between 60 and 86,400 seconds). Devices appear in Radar, Devices.',
      },
      {
        kind: 'p',
        text: 'A scan uses ping, the computer’s neighbour table, the maker of each network card (from the public IEEE list) and the names devices announce about themselves. Phones often stay silent while they are locked, so they may appear later.',
      },
      {
        kind: 'note',
        tone: 'warn',
        text: 'Only authorize networks your organization owns or is allowed to monitor. Nigafiy records who authorized each range.',
      },
    ],
    links: [
      { href: '/sensors', label: 'Sensors' },
      { href: '/radar/discovery', label: 'Discovery' },
    ],
  },
  {
    id: 'devices',
    group: 'tasks',
    program: 'radar',
    title: 'Add and organize devices',
    summary: 'Discovered devices, what you can set by hand, approvals and groups.',
    blocks: [
      { kind: 'h', id: 'discovered', text: 'Discovered devices' },
      {
        kind: 'p',
        text: 'Radar adds devices by itself: every device a Sensor sees in an authorized range appears in Radar, Devices. Each device page shows how it was identified and where each fact came from.',
      },
      {
        kind: 'list',
        items: [
          '"Identified by IP only": the Sensor could not see the device’s hardware (MAC) address, for example on another subnet behind a router.',
          '"Private (randomized) MAC": the device hides its real hardware address, as most phones do. Such devices have no maker name.',
        ],
      },
      { kind: 'h', id: 'manual', text: 'Can I add a device by hand?' },
      {
        kind: 'p',
        text: 'No. Radar lists only devices a Sensor has really seen, so the list never shows something that is not on the network. What you set by hand is everything about a device: its name, type, owner, notes, tags and whether it is critical.',
      },
      {
        kind: 'p',
        text: 'If a device you know about is missing: check that its range is authorized and the Sensor is Reporting, then choose Scan now. Some devices answer neither ping nor neighbour lookups; adding your router (Guard) or your switches (Radar, Switch ports) gives Nigafiy more places to see them.',
      },
      { kind: 'h', id: 'naming', text: 'Naming and describing a device' },
      {
        kind: 'steps',
        items: [
          'Open the device from Radar, Devices.',
          'Under Manage, fill in Display name, Assigned owner, Notes and Tags (separated by commas).',
          'Tick Critical device if it matters: when it goes offline you get a critical alert instead of an ordinary event.',
          'If Nigafiy guessed the wrong type, set the type yourself. Reset type to automatic lets Nigafiy classify it again.',
        ],
      },
      { kind: 'h', id: 'review', text: 'Approving devices' },
      {
        kind: 'p',
        text: 'Each device asks: Do you recognize this device? Not reviewed devices warn you when they join; Known devices alert only on real changes; Unwanted devices raise a critical alert every time they appear. Mark all unreviewed as known does it in one go, but only use it if you recognize every one.',
      },
      {
        kind: 'list',
        items: [
          'Mute alerts for this device: no online/offline alerts, useful for phones and laptops that come and go.',
          'Monitor every minute (admins): a ping check that records delay and loss and follows the device if its address changes.',
          'Wake it up: sends a Wake-on-LAN packet through the Sensor. It works only if Wake-on-LAN is turned on in that device and it is plugged in.',
        ],
      },
      { kind: 'h', id: 'groups', text: 'Groups' },
      {
        kind: 'p',
        text: 'In Radar, tags are the groups: give devices the same tag (for example "printers" or "2nd floor") and type the tag in the search box to list them together. Company computers in Nigafiy Fleet have groups of their own: each Fleet group carries an access policy (Fleet, Access policies).',
      },
    ],
    links: [{ href: '/radar/devices', label: 'Devices' }],
  },
  {
    id: 'fleet-enroll',
    group: 'tasks',
    program: 'fleet',
    title: 'Add a computer to Fleet',
    summary: 'Enroll a company computer with the Nigafiy agent, roll it out silently, or help someone once with Quick Support.',
    blocks: [
      {
        kind: 'p',
        text: 'Nigafiy Fleet manages company computers that run the Nigafiy agent (Windows, Linux and macOS) and Android phones that run the Nigafiy app (see Android phones below). iPhones and iPads are not managed: that needs a paid Apple account. Only enroll devices your organization owns or manages.',
      },
      { kind: 'h', id: 'enroll', text: 'Create the computer in Nigafiy' },
      {
        kind: 'steps',
        items: [
          'Open Fleet, Managed computers and choose Enroll endpoint. (From a device page in Radar you can start the same thing; the name and system are taken from the device.)',
          'Type a label such as `Accounting-PC-01` and choose the operating system.',
          'Choose Create & generate enrollment credentials. The token works once, expires in 24 hours and is shown only once. The window also shows the command lines for Windows, Linux and macOS.',
        ],
      },
      { kind: 'h', id: 'agent', text: 'Install the agent on one computer' },
      {
        kind: 'p',
        text: 'On Windows, run the agent setup (`Nigafiy-Endpoint-Agent-Setup-<version>.exe`) as an administrator and enter the Nigafiy server address and the token. The agent installs into `C:\\Program Files\\Nigafiy\\Endpoint Agent` and runs as the Windows service `NigafiyEndpointAgent`. Once it checks in, the computer shows as Online, and if it matches a device Radar already knows, the two are linked.',
      },
      { kind: 'h', id: 'gpo', text: 'Many Windows computers: silent install with Group Policy' },
      {
        kind: 'p',
        text: 'The same setup runs silently from a Group Policy startup script, an Intune Win32 app or SCCM:',
      },
      {
        kind: 'p',
        text: '`Nigafiy-Endpoint-Agent-Setup-<version>.exe /S /SERVER=https://nigafiy.example /TOKENFILE=\\\\server\\enroll$\\%COMPUTERNAME%.txt`',
      },
      {
        kind: 'list',
        items: [
          'Every computer needs its own token: there is no single token for the whole company. Create one endpoint per computer and save each token in a file named after that computer.',
          'Prefer `/TOKENFILE` to `/TOKEN`: a token typed on a command line can be seen by other administrators’ tools while setup runs. Keep the share readable by Domain Computers only, and delete the files once the computers have enrolled.',
          'Silent mode needs an `https://` server address.',
          'Exit code `0` means installed, `1` that the agent’s install step failed (the reason is in `install.log` in the install folder), `2` that an option was missing or wrong.',
          'To upgrade later, run the newer setup with `/S` alone; it keeps the settings and the enrollment.',
        ],
      },
      {
        kind: 'note',
        tone: 'warn',
        text: 'The agent setup has been built and checked, but its silent install has not yet been run on a real company network. Try it on one computer before a wide rollout.',
      },
      { kind: 'h', id: 'android', text: 'Android phones' },
      {
        kind: 'p',
        text: 'Android management is free: the Nigafiy app is installed from its APK file (no Google Play, no Google account, no Firebase). The app talks only to your Nigafiy server, over HTTPS with the same certificate pin as the Windows agent, and shows a permanent “Managed by Nigafiy” notification.',
      },
      {
        kind: 'table',
        head: ['Mode', 'How', 'What Fleet can do'],
        rows: [
          ['Regular app', 'Install the APK and enroll with the QR code or the three values', 'Inventory (model, Android version, patch level, storage, memory, battery, network, apps) and the compliance checks (screen lock, encryption, patch age, developer options, USB debugging, install unknown apps)'],
          ['Device Owner', 'QR provisioning on a factory-reset phone, or `adb shell dpm set-device-owner com.nigafiy.agent/.admin.NigafiyAdminReceiver` on a phone without accounts', 'Everything above, plus lock now, disable the camera, require a screen lock, install an APK uploaded to Fleet, remove an app, erase the phone and stop management'],
        ],
      },
      {
        kind: 'steps',
        items: [
          'Build the app once on the Nigafiy server: `pnpm build:android` (needs JDK 17 and the Android SDK; see docs/features/android.md).',
          'In Fleet, choose Enroll endpoint, platform Android. The window shows two codes: the app link for a phone that already has the app, and the Device Owner code for a factory-reset phone.',
          'Regular app: copy the APK to the phone, install it (Android asks to allow installs from that source once), then scan the app link with the camera or type server, token and pin into the app.',
          'Device Owner: on the welcome screen of a factory-reset phone tap six times, join Wi-Fi and scan the Device Owner code. Android downloads the app from your server, checks its SHA-256 and enrolls it.',
          'Open the phone in Fleet: the Phone card shows the mode, battery, network and patch level, and the actions the mode allows.',
        ],
      },
      {
        kind: 'list',
        items: [
          'Lock, camera and screen-lock requirement: technician and above. Installing and removing apps: admin.',
          'Erase and Stop management: admin, always with your verification code (authenticator app), and with a second admin’s approval when the phone’s Fleet group asks for approvals (Fleet, Approvals).',
          'The phone’s Fleet group policy applies to every action: allowed roles, addresses, hours and the verification code.',
          'Android gives apps no CPU load, so Fleet shows CPU as not measured on phones.',
          'Without Device Owner Android does not allow those actions at all; making an existing phone Device Owner needs a factory reset or removing its accounts first.',
        ],
      },
      {
        kind: 'note',
        tone: 'warn',
        text: 'The Android app has been built, signed and unit-tested, and the server side is tested, but it has not yet run on a real phone or an emulator. Try it on one test phone first.',
      },
      { kind: 'h', id: 'quick-support', text: 'Quick Support: help a computer without the agent' },
      {
        kind: 'steps',
        items: [
          'Open Fleet, Help requests. In the Quick Support panel choose the site and Download nigafiy-support.exe.',
          'Send the file to the person. It installs nothing; it shows a 9-digit code and a one-time PIN.',
          'Choose Connect with code and PIN and type what the person reads to you. They still click Accept before you see their screen.',
        ],
      },
      {
        kind: 'p',
        text: 'A Quick Support session is always attended and allows at most the Support profile. The downloaded program removes itself when the session ends. If the file is not signed, Windows SmartScreen may warn the person before it runs.',
      },
      {
        kind: 'p',
        text: 'Nigafiy Quick Support is also packaged for the Microsoft Store, without any warning. A person who installed it from the Store needs a link instead of the file: choose Copy Microsoft Store link in the same panel and send it. Opening the link starts Quick Support for your server; the link is signed and valid for a limited number of days. The Store version cannot remove itself; the person removes it in Windows Settings, Apps. (Not yet published or tried on a real computer.)',
      },
    ],
    links: [
      { href: '/fleet/endpoints', label: 'Managed computers' },
      { href: '/fleet/requests', label: 'Help requests' },
    ],
  },
  {
    id: 'routers',
    group: 'tasks',
    program: 'guard',
    title: 'Reach your router',
    summary: 'Add router credentials, which routers are supported, what each can do, and the safety rules.',
    blocks: [
      {
        kind: 'p',
        text: 'Guard, Routers & gateways reads your router: who is connected, DHCP addresses, Wi-Fi networks and port forwards. Where the router allows it, it also makes the changes you ask for. Your site’s Sensor talks to the router, not your browser.',
      },
      { kind: 'h', id: 'add', text: 'Adding the router' },
      {
        kind: 'steps',
        items: [
          'Router: choose Add router. If a Sensor has reported your gateway, its address is filled in. Choose the router family (the vendor).',
          'Sign-in: type the router’s administrator user name and password. They are sent once, stored encrypted, decrypted only for this site’s Sensor and never shown again.',
          'Certificate: most routers identify themselves with a certificate they made themselves. Confirm it once; afterwards the Sensor refuses to talk to anything presenting a different one.',
          'First read: Nigafiy reads the router to learn its model, what it supports and which devices it serves. This only reads; nothing is changed.',
        ],
      },
      {
        kind: 'list',
        items: [
          'OPNsense: the API key is the user name and the API secret the password.',
          'pfSense: needs the REST API v2 package; user name `api-key` with the API key as password, or an administrator account.',
          'FortiGate: user name `api` with a REST API administrator token as password, or an administrator account.',
          'MikroTik: RouterOS v7 with the REST API turned on. OpenWrt: ubus over HTTP (usually user `root`). UniFi: a local administrator account.',
          'Cisco IOS XE: release 16.6 or later, RESTCONF turned on and a privilege-15 account. Port forwards need NAT already set up by the administrator.',
        ],
      },
      { kind: 'h', id: 'families', text: 'Supported routers' },
      {
        kind: 'table',
        head: ['Family', 'Examples'],
        rows: [
          ['Huawei home and ISP gateways', 'DG8045, HG630, HG633, HG8145V5, WS5200, AX3'],
          ['Huawei 4G/5G home routers', 'B315, B525, B535, B818, H122, H155'],
          ['ZTE ZXHN', 'H168N, H188A, F660, F670L, F680'],
          ['TP-Link home / Archer', 'C6, C80, AX10, AX23, AX53, AX73, VR400'],
          ['Tenda', 'F3, AC6, AC10, AC11, AC15, AC23'],
          ['D-Link', 'DIR, EXO and COVR models with HNAP'],
          ['ASUS', 'Asuswrt and Asuswrt-Merlin'],
          ['Zyxel', 'VMG3625-T50B and other ZCFG gateways'],
          ['MikroTik', 'RouterOS v7'],
          ['Ubiquiti UniFi', 'UniFi OS consoles and self-hosted UniFi Network'],
          ['TP-Link Omada', 'Hardware and software controllers'],
          ['OpenWrt, OPNsense, pfSense, FortiGate', 'Firewalls and open-source routers'],
          ['Cisco IOS XE', 'Routers and L3 gateways with RESTCONF (release 16.6 or later)'],
        ],
      },
      {
        kind: 'p',
        text: 'Every family can list connected devices and block or unblock a device. What else each one can do depends on what the router itself offers:',
      },
      {
        kind: 'table',
        head: ['Router', 'Rename', 'Wi-Fi', 'Reservations', 'Port forward', 'Restart', 'Speed limit', 'Schedule'],
        rows: [
          ['MikroTik', 'Yes', 'Yes', 'Yes', 'Yes', 'Yes', 'Yes', 'Yes'],
          ['Zyxel', 'Yes', 'Yes', 'Yes', 'Yes', 'Yes', 'Upload only', 'Yes'],
          ['UniFi', 'Yes', 'Yes', 'Yes', 'Yes', 'Yes', 'Yes', 'Network 7.x+'],
          ['FortiGate', 'Via reservation', 'Yes', 'Yes', 'Yes', 'Yes', 'Yes', 'Yes'],
          ['OpenWrt', 'Yes', 'Yes', 'Yes', 'Yes', 'Yes', 'With nft-qos', 'Yes'],
          ['ASUS', 'Yes', 'Yes', 'Yes', 'Yes', 'Yes', 'No', 'Firmware 386+'],
          ['Omada', 'Yes', 'Yes', 'Yes', 'Yes', 'Yes', 'Yes', 'No'],
          ['Tenda', 'V15.03 only', 'Yes', 'Yes', 'Yes', 'Yes', 'Yes', 'No'],
          ['OPNsense', 'Via reservation', 'No', 'Yes', '26.1+', 'Yes', 'Yes', 'No'],
          ['pfSense', 'Via reservation', 'No', 'Yes', 'Yes', 'Yes', 'No', 'Yes'],
          ['Huawei (home/ISP)', 'Yes', 'Yes', 'Yes', 'Yes', 'Yes', 'No', 'No'],
          ['D-Link, TP-Link, ZTE', 'No', 'Yes', 'Yes', 'Yes', 'Yes', 'No', 'No'],
          ['Huawei 4G/5G', 'No', 'Yes', 'No', 'Yes', 'Yes', 'No', 'No'],
          ['Cisco IOS XE', 'Via reservation', 'No', 'Yes', 'Yes', 'No', 'Yes', 'Yes'],
        ],
      },
      {
        kind: 'p',
        text: '"Via reservation" means the router keeps no device names of its own, so the name goes on the device’s fixed-address (DHCP) reservation. Where a router can block but not schedule, Nigafiy applies your schedule itself by blocking and unblocking at the set times.',
      },
      { kind: 'h', id: 'read-only', text: 'Reading versus changing' },
      {
        kind: 'list',
        items: [
          'Reading never changes anything. Every role can see the router pages.',
          'Changes are for administrators. Each one is an explicit request: Nigafiy changes nothing on the router on its own.',
          'Every change is written to the audit log (never with a password or Wi-Fi key), and the router is read again afterwards, so the page shows what the router really did, not what was asked.',
          'Every change tells you how to undo it.',
        ],
      },
      { kind: 'h', id: 'safety', text: 'Safety rules' },
      {
        kind: 'list',
        items: [
          'Nigafiy refuses to turn off the Wi-Fi network its own Sensor uses, or the one your computer is on. Turning off a main Wi-Fi network asks for confirmation, because every device on it disconnects.',
          'Port forwards cannot use the router’s own management ports (80, 443, 22, 23, 7547) and must point inside your network.',
          'A restart asks you to confirm. The router is unreachable for a few minutes.',
          'If the router rejects the password, Nigafiy stops logging in so the router does not lock the account. Update the credentials to resume.',
          'Nigafiy never lifts a block that an administrator made directly on the router. The rules it creates are labelled so you can recognise them.',
        ],
      },
      {
        kind: 'note',
        tone: 'warn',
        text: 'Only one router, a Zyxel VMG3625-T50B, has been tried for real (block and unblock, rename, reservation, port forward and guest Wi-Fi; restart was never run). The other families are built to each vendor’s documented interface and tested against test doubles, not yet on real hardware. Try a change at a quiet time first.',
      },
    ],
    links: [{ href: '/guard/routers', label: 'Routers & gateways' }],
  },
  {
    id: 'hub',
    group: 'programs',
    program: 'hub',
    title: 'Nigafiy Hub',
    summary: 'Home, sign-in, settings and the engine.',
    blocks: [
      {
        kind: 'list',
        items: [
          'Dashboard: Needs your attention (what to look at now) and a summary from each program.',
          'All sites: every site side by side, for organizations with several locations.',
          'Sensors: each site’s Sensors, whether they are reporting, and enrolling a new one.',
          'Programs: which programs this installation offers.',
          'Settings: your organization, language, Account & Security (password and two-factor sign-in), the system self-check, the local network certificate (LAN TLS), and for administrators the team, single sign-on and the audit log.',
          'System self-check (in Settings, Open the self-check page): every background job with its last run, last error and whether it is overdue.',
        ],
      },
      {
        kind: 'p',
        text: 'The dashboard also shows the engine: the background service that runs the database, the web console and the local Sensor. The summary report button in the top bar opens a printable overview for the selected site.',
      },
    ],
    links: [
      { href: '/', label: 'Dashboard' },
      { href: '/portfolio', label: 'All sites' },
      { href: '/system/modules', label: 'System self-check' },
    ],
  },
  {
    id: 'radar',
    group: 'programs',
    program: 'radar',
    title: 'Nigafiy Radar',
    summary: 'See every device on the network.',
    blocks: [
      {
        kind: 'list',
        items: [
          'Devices: everything the Sensors have seen, with search by name, address, maker, owner or tag.',
          'Discovery: the authorized ranges, the Sensors and Scan now.',
          'Network map: internet, gateway, subnets and devices. Each link says whether it was observed or inferred, and why.',
          'IP addresses: subnets, how full they are, and address conflicts (IPv4 and IPv6).',
          'Switch ports: managed switches read over SNMP: their ports and which device is on which port. You type the SNMP credentials yourself.',
        ],
      },
      {
        kind: 'p',
        text: 'See "Your first network scan" and "Add and organize devices" for the first steps.',
      },
    ],
    links: [
      { href: '/radar/devices', label: 'Devices' },
      { href: '/radar/topology', label: 'Network map' },
      { href: '/radar/ipam', label: 'IP addresses' },
    ],
  },
  {
    id: 'watch',
    group: 'programs',
    program: 'watch',
    title: 'Nigafiy Watch',
    summary: 'Monitor, and understand what went wrong.',
    blocks: [
      {
        kind: 'list',
        items: [
          'Live Monitoring: checks that the Sensor runs on a schedule: ping, TCP port, DNS, web page (HTTP/HTTPS), certificate expiry and SNMP values.',
          'Incidents: related problems grouped into one incident. Acknowledge, assign, comment or resolve with a note; incidents close by themselves when things recover.',
          'Event Timeline: everything that happened, in order.',
          'Network Doctor: explains a problem (your network, the gateway, the internet provider, DNS, a service or a device) with the evidence, what was ruled out and how sure it is.',
          'Insights: a health score with the reason for every point taken off.',
          'Time Machine: how the network looked at a past moment, and a comparison of two periods.',
          'Impact analysis: what depends on a device, before you change or unplug it.',
          'Reports: a printable summary.',
          'Notifications: email, webhooks, Telegram, Slack, Discord and ntfy, with escalation if nobody reacts.',
          'Maintenance windows: planned work that silences alerts while it lasts.',
        ],
      },
      {
        kind: 'note',
        tone: 'info',
        text: 'Network Doctor uses fixed, written rules, not AI. Every conclusion shows the measurements behind it.',
      },
    ],
    links: [
      { href: '/watch/monitoring', label: 'Live Monitoring' },
      { href: '/watch/incidents', label: 'Incidents' },
      { href: '/watch/doctor', label: 'Network Doctor' },
    ],
  },
  {
    id: 'guard',
    group: 'programs',
    program: 'guard',
    title: 'Nigafiy Guard',
    summary: 'Protect and control the network.',
    blocks: [
      {
        kind: 'list',
        items: [
          'Smart checks: the Sensor looks for an unexpected DHCP server, risky UPnP settings on the router, weak Wi-Fi security and exposed services. These checks only read.',
          'Access control: a DNS filter run by the Sensor. With it on, you can pause a device’s internet and block ads and malware. A paused device stays on the Wi-Fi; only websites and apps stop.',
          'Routers & gateways: see "Reach your router".',
          'Switch port control: turn a switch port off or on, change its VLAN or quarantine a device, over SNMP.',
          'Config backup: copies of your switches’ and routers’ configuration over SSH, with passwords removed and the differences between copies. Restoring a copy works for Juniper Junos and Cisco IOS XE, which roll a configuration back by themselves when it is not confirmed.',
        ],
      },
      {
        kind: 'note',
        tone: 'warn',
        text: 'Smart checks have run on a real office network. Switch port control and config backup have only been tested against test doubles, not on real switches.',
      },
    ],
    links: [
      { href: '/guard/security', label: 'Smart checks' },
      { href: '/guard/access', label: 'Access control' },
      { href: '/guard/config-backup', label: 'Config backup' },
    ],
  },
  {
    id: 'fleet',
    group: 'programs',
    program: 'fleet',
    title: 'Nigafiy Fleet',
    summary: 'Manage and support company computers.',
    blocks: [
      {
        kind: 'p',
        text: 'Managed computers lists every enrolled computer: online or offline, who is signed in, CPU, memory and storage, and compliance issues. Open a computer for its tabs:',
      },
      {
        kind: 'list',
        items: [
          'Security and compliance: what is checked and the evidence behind every result.',
          'Remote desktop: see and, if allowed, control the screen.',
          'Files: browse and transfer files, checked with SHA-256.',
          'Software, hardware and licences, patches, commands (processes, services, power, a message to the user) and the remote shell.',
        ],
      },
      { kind: 'h', id: 'transparency', text: 'What the person at the computer sees' },
      {
        kind: 'p',
        text: 'Company computers are silent by default: an unattended computer, in no group or in an unattended group with the banner off, shows no prompt and no bar. Attended groups, help requests, Quick Support and phones still ask the person and show a bar with the operator’s name, the reason and what is allowed, and an End button. An administrator changes it per group in Access policies (Session banner on the computer). Every session is in the audit log either way. Nigafiy never records keystrokes, and typed text and file contents never reach the audit log.',
      },
      {
        kind: 'note',
        tone: 'info',
        text: 'On macOS, remote desktop is view-only. The Linux and macOS agents have been built and unit-tested but not yet run on those systems.',
      },
    ],
    links: [{ href: '/fleet/endpoints', label: 'Managed computers' }],
  },
  {
    id: 'fleet-pro',
    group: 'programs',
    program: 'fleet',
    title: 'Fleet Pro (inside Nigafiy Fleet)',
    summary: 'Remote support for a team: sessions, help requests, policies, approvals, scripts, jobs, patches and monitoring.',
    blocks: [
      {
        kind: 'list',
        items: [
          'Remote sessions: every session, who ran it, why, and its recording if one was made.',
          'Help requests: people ask for help from the Nigafiy icon next to the clock; start an attended session from their request. Quick Support is here too.',
          'Access policies: groups of computers, each with its rules: attended (the person must accept) or unattended, allowed hours, which roles may connect, the default and highest permission profile, a two-factor code, a second administrator’s approval, and allowed addresses.',
          'Approvals: sessions waiting for a second administrator. The person who asked cannot approve their own request.',
          'Scripts and Jobs: a library of scripts, run on chosen computers now or at a set time.',
          'Patches: available updates read by the agent (Windows Update, apt or dnf on Linux, softwareupdate on macOS), with approvals and install policies.',
          'Monitoring: rules for CPU, memory, free disk, a stopped service or event-log entries. A breach opens an incident in Watch.',
        ],
      },
      {
        kind: 'table',
        head: ['Permission profile', 'Allows'],
        rows: [
          ['View only', 'Seeing the screen (and recording).'],
          ['Support', 'Seeing and controlling, clipboard both ways, files, recording and restart.'],
          ['Full admin', 'Everything, including the remote shell where the policy allows it.'],
        ],
      },
      {
        kind: 'p',
        text: 'The remote shell is off by default. When a policy turns it on, only administrators can open it, the banner names the operator (unless the group’s banner is off), and the transcript is kept encrypted.',
      },
      {
        kind: 'note',
        tone: 'warn',
        text: 'The Fleet Pro pages open without errors, and parts of the agent (the remote shell, scripts, reading Windows Update) have run on one development computer. A session with a second real computer, a real update install and Quick Support from a downloaded file have not been tried yet.',
      },
    ],
    links: [
      { href: '/fleet/sessions', label: 'Remote sessions' },
      { href: '/fleet/policies', label: 'Access policies' },
      { href: '/fleet/patches', label: 'Patches' },
    ],
  },
  {
    id: 'mind',
    group: 'programs',
    program: 'mind',
    title: 'Nigafiy Mind',
    summary: 'Knowledge, playbooks and automation.',
    blocks: [
      {
        kind: 'list',
        items: [
          'Knowledge base: what fixed problems before, and the guides your team wrote. A resolved incident with a note becomes a suggestion; a person reviews it and publishes it.',
          'Playbooks: short lists of steps that start on an event, an incident, a schedule or by hand. Steps that could disrupt anything wait for an administrator’s approval unless an administrator allowed them to run without asking. Every run records what started it and each step’s result.',
          'Automation: what Nigafiy does or suggests by itself. Every automatic action is written to the audit log as “System”. Consent and security steps (authorizing a range, enrolling a computer, turning on filtering, credentials) are never automated.',
        ],
      },
      {
        kind: 'note',
        tone: 'info',
        text: 'Mind uses no AI. Suggestions come from your own resolved incidents and fixed rules.',
      },
    ],
    links: [
      { href: '/mind/knowledge', label: 'Knowledge base' },
      { href: '/mind/playbooks', label: 'Playbooks' },
    ],
  },
  {
    id: 'toolbox',
    group: 'programs',
    program: 'toolbox',
    title: 'Nigafiy Toolbox',
    summary: 'Quick network tools.',
    blocks: [
      {
        kind: 'list',
        items: [
          'IT Toolbox: ping, traceroute, TCP port check, a scan of common ports, DNS lookup and reverse DNS. They run from the site’s Sensor, not from your browser.',
          'Subnet calculator: IPv4 and IPv6 ranges, masks and splits. It runs in your browser and touches no network.',
        ],
      },
      {
        kind: 'p',
        text: 'The tools only reach addresses inside your authorized ranges. Ping, traceroute and reverse DNS may also reach internet addresses; port checks never do.',
      },
    ],
    links: [
      { href: '/toolbox', label: 'IT Toolbox' },
      { href: '/toolbox/subnet', label: 'Subnet calculator' },
    ],
  },
  {
    id: 'troubleshooting',
    group: 'help',
    program: null,
    title: 'Troubleshooting and questions',
    summary: 'The usual problems and how to solve them.',
    blocks: [
      { kind: 'h', id: 'no-devices', text: 'No devices appear' },
      {
        kind: 'list',
        items: [
          'Check that the site has a Sensor in the Reporting state (Hub, Sensors).',
          'Check that a range is authorized in Radar, Discovery, and that it is the range your computers really use.',
          'Choose Scan now and wait about 30 seconds.',
        ],
      },
      { kind: 'h', id: 'sensor-offline', text: 'A Sensor is "Out of contact"' },
      {
        kind: 'p',
        text: 'The computer it runs on is off, asleep, disconnected, or the Sensor program stopped. Start it again; it sends what it buffered while it was away. While no Sensor reports, device states read Unknown rather than a guess.',
      },
      { kind: 'h', id: 'router-login', text: 'The router says logins are paused' },
      {
        kind: 'p',
        text: 'The router rejected the user name or password, so Nigafiy stopped trying before the router locked the account. Open the router, choose Edit, then Replace credentials. New credentials end the pause.',
      },
      { kind: 'h', id: 'router-certificate', text: 'The router’s certificate changed' },
      {
        kind: 'p',
        text: 'After a factory reset or a firmware update a router may present a new certificate, and the Sensor refuses it. Fetch the certificate again and confirm it only if you expected the change.',
      },
      { kind: 'h', id: 'not-installed', text: 'A page says "Not installed"' },
      {
        kind: 'p',
        text: 'That program was left out when Nigafiy was installed. Run the installer again and choose it (see "The seven programs").',
      },
      { kind: 'h', id: 'session-refused', text: 'A remote session is refused' },
      {
        kind: 'p',
        text: 'The computer’s access policy decides: allowed hours, roles, a two-factor code, a second administrator’s approval, or allowed addresses. The message says which rule refused it. Ask an administrator to check Fleet, Access policies.',
      },
      { kind: 'h', id: 'noisy-phone', text: 'A phone keeps going offline and online' },
      {
        kind: 'p',
        text: 'Phones sleep and change networks. Open the device and choose Mute alerts for this device.',
      },
      { kind: 'h', id: 'background-jobs', text: 'Something seems stuck' },
      {
        kind: 'p',
        text: 'Open System self-check (in Settings, Open the self-check page). It lists every background job with its last run and last error, and flags the overdue ones.',
      },
      { kind: 'h', id: 'audit', text: 'Who changed what?' },
      {
        kind: 'p',
        text: 'Administrators find the audit log in Settings. Every change, by a person or by Nigafiy itself (“System”), is recorded there.',
      },
      { kind: 'h', id: 'ai', text: 'Does Nigafiy use AI?' },
      {
        kind: 'p',
        text: 'No. Every diagnosis, suggestion and number comes from fixed rules and real measurements, and shows its evidence.',
      },
      { kind: 'h', id: 'cost', text: 'Does it cost anything?' },
      { kind: 'p', text: 'Nigafiy is free for now.' },
    ],
    links: [
      { href: '/sensors', label: 'Sensors' },
      { href: '/system/modules', label: 'System self-check' },
    ],
  },
];
