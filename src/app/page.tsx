import { getFamilyDataOnServer } from '@/utils/config';
import HomeClient from './components/HomeClient';

// 服务端渲染：每次请求在服务器端读取族谱数据并注入页面，
// 浏览器只拿到渲染好的页面，不存在可批量爬取数据的 JSON 接口。
export const dynamic = 'force-dynamic';

export default async function Page() {
  const data = await getFamilyDataOnServer();
  return <HomeClient initialData={data} />;
}
