"use client";

import { useState, useEffect, useMemo, useCallback } from 'react';
import FamilyTree from './FamilyTree';
import TreeView from './TreeView';
import Footer from './Footer';
import LoginForm from './LoginForm';
import SearchBar, { SearchFilters } from './SearchBar';
import { QueueListIcon, Squares2X2Icon, ArrowRightOnRectangleIcon } from '@heroicons/react/24/outline';
import { getPublicConfig } from '@/utils/config';
import { FamilyData } from '@/types/family';
import { searchFamilyData, createFilteredFamilyData, SearchResult } from '@/utils/search';
import { AUTH_CONFIG } from '@/utils/constants';

export default function HomeClient({ initialData, serverAuthed = false, registrationOpen = false, familyName = '白' }: { initialData: FamilyData; serverAuthed?: boolean; registrationOpen?: boolean; familyName?: string }) {
  const [viewMode, setViewMode] = useState<'list' | 'tree'>('list');
  const [isAuthenticated, setIsAuthenticated] = useState(serverAuthed);
  const [loading, setLoading] = useState(true);
  const [userName, setUserName] = useState('');
  // 数据由服务端组件在请求时读取并注入，不再经客户端接口拉取（无可爬取的 JSON 接口）
  const familyData = initialData;
  const dataLoading = false;
  const dataError: string | null = null;
  
  // Search related state
  const [searchTerm, setSearchTerm] = useState('');
  const [searchFilters, setSearchFilters] = useState<SearchFilters>({
    searchTerm: '',
    searchInInfo: true,
    selectedGenerations: [],
    yearRange: {}
  });
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  
  // 使用useMemo缓存配置，避免每次render重新计算
  const publicConfig = useMemo(() => getPublicConfig(), []);
  const requireAuth = publicConfig.isAuthRequired;
  const familyFullName = `${familyName}氏`;

  // 使用useMemo缓存过滤后的家族数据
  const filteredFamilyData = useMemo(() => {
    if (searchResults.length > 0) {
      return createFilteredFamilyData(familyData, searchResults);
    }
    return familyData;
  }, [familyData, searchResults]);

  // 使用useCallback缓存搜索处理函数
  const handleSearch = useCallback((term: string, filters: SearchFilters) => {
    setSearchTerm(term);
    setSearchFilters(filters);
  }, []);

  // Search effect - 使用useEffect处理搜索逻辑
  useEffect(() => {
    if (!dataLoading && !dataError && familyData.generations.length) {
      if (searchTerm || searchFilters.selectedGenerations.length > 0 || 
          searchFilters.yearRange.start || searchFilters.yearRange.end) {
        const results = searchFamilyData(familyData, searchTerm, searchFilters);
        setSearchResults(results);
      } else {
        setSearchResults([]);
      }
    }
  }, [familyData, searchTerm, searchFilters, dataLoading, dataError]);

  // 使用useCallback缓存认证相关函数
  const handleLoginSuccess = useCallback(() => {
    setIsAuthenticated(true);
  }, []);
  
  const handleLogout = useCallback(async () => {
    // 退出登录：请服务端清掉会话 Cookie 后刷新页面，服务端会重新渲染登录页。
    // 会话 Cookie 是 HttpOnly，前端 JS 删不掉；请求失败时明确提示重试，不能假装已退出
    try {
      const res = await fetch('/api/auth/logout', { method: 'POST' });
      if (!res.ok) throw new Error(`logout failed: ${res.status}`);
      window.location.reload();
    } catch {
      window.alert('退出失败，请检查网络后重试');
    }
  }, []);

  useEffect(() => {
    // 服务端已验过会话 Cookie 时直接放行，不再走本地令牌检查
    if (serverAuthed) {
      setIsAuthenticated(true);
      setLoading(false);
      return;
    }
    // 始终假设需要登录验证 - 真实的验证会在服务器端处理
    
    // 检查是否已经验证过 - 使用常量
    const token = localStorage.getItem(AUTH_CONFIG.STORAGE_KEYS.AUTH_TOKEN);
    const authTime = localStorage.getItem(AUTH_CONFIG.STORAGE_KEYS.AUTH_TIME);
    
    if (token && authTime) {
      try {
        // 使用Buffer解码token
        const tokenData = Buffer.from(token.split('.')[0], 'base64url').toString();
        const parsedToken = JSON.parse(tokenData);
        const expirationTime = parsedToken.exp;
        const currentTime = Date.now();
        
        // 检查token是否过期
        if (currentTime < expirationTime) {
          setIsAuthenticated(true);
          setUserName('');
        } else {
          // 清除过期的token
          localStorage.removeItem(AUTH_CONFIG.STORAGE_KEYS.AUTH_TOKEN);
          localStorage.removeItem(AUTH_CONFIG.STORAGE_KEYS.AUTH_TIME);
        }
      } catch (error) {
        console.error('Token解析错误:', error);
        // token解析错误，清除
        localStorage.removeItem(AUTH_CONFIG.STORAGE_KEYS.AUTH_TOKEN);
        localStorage.removeItem(AUTH_CONFIG.STORAGE_KEYS.AUTH_TIME);
      }
    }
    
    setLoading(false);
  }, []);

  // 显示加载状态
  if (loading || dataLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  // 如果需要登录且未验证，显示登录表单
  if (requireAuth && !isAuthenticated) {
    return <LoginForm registrationOpen={registrationOpen} familyName={familyName} />;
  }

  // 已验证或不需要登录，显示家谱内容
  return (
    <main className="min-h-screen bg-gray-50 flex flex-col">
      <header className="bg-white shadow-sm mb-4">
        <div className="max-w-7xl mx-auto px-4 py-6 relative">
          {/* 只有在需要登录且已登录的情况下才显示退出按钮 */}
          {requireAuth && isAuthenticated && (
            <div className="absolute right-4 top-4">
              <button
                onClick={handleLogout}
                className="inline-flex items-center px-3 py-2 border border-gray-300 shadow-sm text-sm leading-4 font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
              >
                <ArrowRightOnRectangleIcon className="h-4 w-4 mr-1" />
                退出
              </button>
            </div>
          )}
          
          <h1 className="text-3xl font-bold text-gray-900 text-center">
            {familyFullName}族谱
          </h1>
          <p className="mt-2 text-gray-500 text-center text-sm tracking-wide">
            传承历史 · 延续文化
          </p>
          {requireAuth && userName && (
            <p className="mt-1 text-blue-500 text-center text-xs">
              欢迎您，{familyFullName}族人
            </p>
          )}
          <div className="mt-6 flex justify-center">
            <div className="inline-flex rounded-md shadow-sm">
              <button
                type="button"
                className={`px-4 py-2 text-sm font-medium rounded-l-md flex items-center ${
                  viewMode === 'list'
                    ? 'bg-blue-50 text-blue-700 border border-blue-200'
                    : 'bg-white text-gray-700 border border-gray-200 hover:bg-gray-50'
                }`}
                onClick={() => setViewMode('list')}
              >
                <QueueListIcon className="h-4 w-4 mr-2" />
                列表视图
              </button>
              <button
                type="button"
                className={`px-4 py-2 text-sm font-medium rounded-r-md flex items-center ${
                  viewMode === 'tree'
                    ? 'bg-blue-50 text-blue-700 border border-blue-200'
                    : 'bg-white text-gray-700 border border-gray-200 hover:bg-gray-50'
                }`}
                onClick={() => setViewMode('tree')}
              >
                <Squares2X2Icon className="h-4 w-4 mr-2" />
                树状视图
              </button>
            </div>
          </div>
        </div>
      </header>
      
      <div className="flex-grow">
        {dataError && (
          <div className="text-center text-red-500 mb-4">
            {dataError} - 使用默认数据
          </div>
        )}
        
        <div className="max-w-7xl mx-auto px-4 mb-6">
          {/* 搜索框 */}
          <div className="flex justify-end mb-4">
            <SearchBar 
              onSearch={handleSearch}
              generations={familyData.generations.map(g => g.title)}
            />
          </div>
          
          {/* 搜索结果提示 */}
          {searchResults.length === 0 && (searchTerm || searchFilters.selectedGenerations.length > 0 || 
           searchFilters.yearRange.start || searchFilters.yearRange.end) && (
            <div className="text-center text-gray-500 py-8">
              <p className="text-lg">未找到匹配的家族成员</p>
              <p className="text-sm">请尝试修改搜索条件</p>
            </div>
          )}
          
          {searchResults.length > 0 && (
            <div className="text-sm text-gray-600 text-center mb-4">
              找到 <span className="font-medium text-blue-600">{searchResults.length}</span> 个匹配结果
            </div>
          )}
        </div>
        
        {viewMode === 'list' ? (
          <FamilyTree 
            familyData={filteredFamilyData} 
            searchTerm={searchTerm}
            searchInInfo={searchFilters.searchInInfo}
            searchActive={searchResults.length > 0}
          />
        ) : (
          <TreeView
            data={familyData}
            searchTerm={searchTerm}
            searchInInfo={searchFilters.searchInInfo}
          />
        )}
      </div>
      
      <Footer familyFullName={familyFullName} />
    </main>
  );
}
