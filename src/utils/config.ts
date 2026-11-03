import { FamilyData } from '../types/family';

// 定义配置类型（口令与签名密钥只经 utils/auth.ts 在服务端读取，不进这里）
export interface AuthConfig {
  requireAuth: boolean;
  familyName: string;
}

// 客户端公开配置类型（不包含敏感信息）
export interface PublicConfig {
  familyName: string;
  isAuthRequired: boolean; // 只公开是否需要认证，不公开具体验证细节
}

// 默认空的家族数据
const defaultFamilyData: FamilyData = {
  generations: []
};

// 缓存配置数据
let authConfigCache: AuthConfig | null = null;

// 在服务器端加载配置文件
async function loadConfigOnServer<T>(filename: string, defaultConfig: T): Promise<T> {
  // 检查是否在服务器端
  if (typeof window !== 'undefined') {
    console.warn(`Cannot load ${filename} in browser environment, using default config`);
    return defaultConfig;
  }

  try {
    // 动态导入fs和path模块(仅在服务器端)
    const [fs, path] = await Promise.all([
      import('fs').then(m => m.default),
      import('path').then(m => m.default)
    ]);
    
    // 优先用环境变量 CONFIG_DIR（Docker 里固定为 /app/config），避免进程工作目录变化导致读不到数据
    const configDir = process.env.CONFIG_DIR || path.join(process.cwd(), 'config');
    const filePath = path.join(configDir, filename);
    
    if (fs.existsSync(filePath)) {
      const fileContent = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(fileContent) as T;
    }
  } catch (error) {
    console.warn(`Error loading config file ${filename}:`, error);
  }
  
  return defaultConfig;
}

// 从环境变量读取服务器端认证配置
// 鉴权开关以服务端变量 REQUIRE_AUTH 为准（NEXT_PUBLIC_REQUIRE_AUTH 仅供客户端决定是否显示登录页，两者需保持一致）
function getAuthConfigOnServerFromEnv(): AuthConfig {
  return {
    requireAuth: process.env.REQUIRE_AUTH === 'true' || process.env.NEXT_PUBLIC_REQUIRE_AUTH === 'true',
    familyName: process.env.NEXT_PUBLIC_FAMILY_NAME || '姓氏'
  };
}

// 从环境变量读取客户端公开配置
function getPublicConfigFromEnv(): PublicConfig {
  return {
    familyName: process.env.NEXT_PUBLIC_FAMILY_NAME || '姓氏',
    isAuthRequired: process.env.NEXT_PUBLIC_REQUIRE_AUTH === 'true'
  };
}

// 导出配置访问函数 - 仅用于服务器端组件
export async function getAuthConfigOnServer(): Promise<AuthConfig> {
  if (authConfigCache) return authConfigCache;
  
  // 直接从环境变量读取配置
  const config = getAuthConfigOnServerFromEnv();
  authConfigCache = config;
  return config;
}

// 在客户端用于获取完整的姓氏名称（带"氏"字）
export function getFamilyFullName(): string {
  const config = getPublicConfigFromEnv();
  return `${config.familyName}氏`;
}

// 家谱数据结构校验：数据由人工维护、直接改 JSON，改坏时宁可整页回退空数据也不能让页面崩溃或死循环。
// 只拦真正危险的情况：结构类型不对、id 重复、父子关系成环。
// fatherId 指向不存在的 id 或指向自己时按始祖处理（与 TreeView 的建树规则一致），不拦。
export function validateFamilyData(data: unknown): data is FamilyData {
  if (!data || typeof data !== 'object') return false;
  const generations = (data as FamilyData).generations;
  if (!Array.isArray(generations)) return false;
  const ids = new Set<string>();
  const parentOf = new Map<string, string>();
  for (const g of generations) {
    if (!g || !Array.isArray(g.people)) return false;
    for (const p of g.people) {
      if (!p || typeof p.id !== 'string' || !p.id || typeof p.name !== 'string') return false;
      if (ids.has(p.id)) return false;
      ids.add(p.id);
      if (typeof p.fatherId === 'string' && p.fatherId && p.fatherId !== p.id) {
        parentOf.set(p.id, p.fatherId);
      }
    }
  }
  // 父链环检测：沿 fatherId 一直往上走，走回已访问过的节点即成环
  for (const id of parentOf.keys()) {
    const seen = new Set<string>([id]);
    let cur = parentOf.get(id);
    while (cur && parentOf.has(cur)) {
      if (seen.has(cur)) return false;
      seen.add(cur);
      cur = parentOf.get(cur);
    }
  }
  return true;
}

export async function getFamilyDataOnServer(): Promise<FamilyData> {
  // 不缓存：数据文件修改后下一次请求即生效
  const data = await loadConfigOnServer<FamilyData>('family-data.json', defaultFamilyData);
  if (!validateFamilyData(data)) {
    console.error('family-data.json 结构校验未通过（类型不对/id 重复/父子成环），已回退为空数据，请检查数据文件');
    return defaultFamilyData;
  }
  return data;
}

// 客户端公开配置（只包含可以在客户端公开的信息）
export function getPublicConfig(): PublicConfig {
  return getPublicConfigFromEnv();
}

// 对于familyData，我们需要通过API获取，因为这个数据量可能很大
export function getFamilyData(): FamilyData {
  return defaultFamilyData; // 这只是一个默认值，实际数据将通过API加载
} 