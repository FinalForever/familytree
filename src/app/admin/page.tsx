import { cookies } from 'next/headers';
import { getAdminTokenSubject } from '@/utils/auth';
import { ADMIN_COOKIE, ADMIN_SUBJECT } from '@/utils/admin';
import AdminLogin from '../components/AdminLogin';
import AdminPanel from '../components/AdminPanel';

// 管理后台入口：先验管理员会话，未登录只显示管理员登录框
export const dynamic = 'force-dynamic';

export default async function AdminPage() {
  const cookieStore = await cookies();
  const token = cookieStore.get(ADMIN_COOKIE)?.value;

  if (getAdminTokenSubject(token) !== ADMIN_SUBJECT) {
    return <AdminLogin />;
  }
  return <AdminPanel />;
}
