import { cookies } from 'next/headers';
import { getFamilyDataOnServer } from '@/utils/config';
import { getTokenPayload } from '@/utils/auth';
import { findUser, getFamilyName, isRegistrationOpen } from '@/utils/users';
import HomeClient from './components/HomeClient';
import LoginForm from './components/LoginForm';

// 服务端门禁：每次请求先验会话 Cookie（HMAC 签名令牌），且账号必须仍然存在
// （后台删掉账号后，其已发出的会话立即失效）。
// 未登录只渲染登录/注册页，族谱数据一个字节都不下发；
// 登录后才在服务器端读取数据并注入页面渲染（无可爬取的 JSON 接口）。
export const dynamic = 'force-dynamic';

export default async function Page() {
  const cookieStore = await cookies();
  const token = cookieStore.get('ft_session')?.value;
  const payload = getTokenPayload(token);
  const user = payload ? findUser(payload.sub) : undefined;

  // 账号被删、或改密后令牌版本落后于账号当前版本（改密即踢下线），都按未登录处理
  if (!payload || !user || (user.tokenVersion ?? 0) !== payload.ver) {
    return <LoginForm registrationOpen={isRegistrationOpen()} familyName={getFamilyName()} />;
  }

  const data = await getFamilyDataOnServer();
  return <HomeClient initialData={data} serverAuthed familyName={getFamilyName()} />;
}
