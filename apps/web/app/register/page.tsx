import { AuthForm } from '@/features/auth';

export const metadata = { title: 'Create account' };

export default function RegisterPage() {
  return <AuthForm mode="register" />;
}
