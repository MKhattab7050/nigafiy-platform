import { SkeletonBlock } from '@/components/ui';

/** Shown inside the shell while a screen's code loads: the sidebar and top bar stay in place. */
export default function ScreenLoading() {
  return (
    <div className="space-y-6">
      <div className="h-7 w-56 animate-shimmer rounded-[6px] bg-raised" aria-hidden />
      <SkeletonBlock lines={5} chart />
    </div>
  );
}
