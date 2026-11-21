import {
  AppWindow,
  BrickWall,
  Cctv,
  CircleHelp,
  CircuitBoard,
  Globe,
  HardDrive,
  Laptop,
  type LucideIcon,
  Monitor,
  Network,
  Printer,
  Router,
  Server,
  Smartphone,
  Terminal,
  Tv,
  Wifi,
} from 'lucide-react';

/** One icon per device type, used the same way on the device list, the map and endpoint pages. */
export const DEVICE_ICON: Record<string, LucideIcon> = {
  windows_computer: Monitor,
  linux_computer: Terminal,
  apple_computer: Laptop,
  server: Server,
  router: Router,
  switch: Network,
  firewall: BrickWall,
  printer: Printer,
  access_point: Wifi,
  camera: Cctv,
  nas: HardDrive,
  iot: CircuitBoard,
  mobile: Smartphone,
  media_player: Tv,
  internet: Globe,
  unknown: CircleHelp,
};

/** Managed-computer platforms (generic glyphs, no vendor marks). */
export const PLATFORM_ICON: Record<string, LucideIcon> = { windows: AppWindow, linux: Terminal, macos: Laptop };

export function DeviceIcon({ type, className }: { type: string | null | undefined; className?: string }) {
  const Icon = DEVICE_ICON[type ?? 'unknown'] ?? CircleHelp;
  return <Icon className={className ?? 'size-4'} aria-hidden />;
}

export function PlatformIcon({ platform, className }: { platform: string; className?: string }) {
  const Icon = PLATFORM_ICON[platform] ?? Monitor;
  return <Icon className={className ?? 'size-4'} aria-hidden />;
}
