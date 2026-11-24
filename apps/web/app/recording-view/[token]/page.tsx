import { UserRecordingScreen } from '@/features/endpoints/screens/user-recording-screen';

export const metadata = { title: 'Nigafiy recording', robots: { index: false, follow: false } };

/** Opened from "Past recordings…" in the Nigafiy tray: the token is the only access. */
export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <UserRecordingScreen token={token} />;
}
