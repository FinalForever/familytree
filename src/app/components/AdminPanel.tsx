"use client";

import { useCallback, useEffect, useState } from 'react';

interface UserItem {
  username: string;
  createdAt: number;
}

export default function AdminPanel() {
  const [users, setUsers] = useState<UserItem[]>([]);
  const [registrationOpen, setRegistrationOpen] = useState<boolean>(true);
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [resetPasswords, setResetPasswords] = useState<Record<string, string>>({});
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const [usersRes, regRes] = await Promise.all([
        fetch('/api/admin/users'),
        fetch('/api/admin/registration'),
      ]);
      const usersData = await usersRes.json();
      const regData = await regRes.json();
      if (usersData.success) setUsers(usersData.users);
      if (regData.success) setRegistrationOpen(regData.registrationOpen);
    } catch {
      setError('加载失败，请刷新重试');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const showResult = (data: { success: boolean; message?: string }, okText: string) => {
    if (data.success) {
      setMessage(okText);
      setError('');
    } else {
      setError(data.message || '操作失败');
      setMessage('');
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    const res = await fetch('/api/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: newUsername, password: newPassword }),
    });
    const data = await res.json();
    showResult(data, `账号 ${newUsername} 已创建`);
    if (data.success) {
      setNewUsername('');
      setNewPassword('');
      load();
    }
  };

  const handleReset = async (username: string) => {
    const password = resetPasswords[username] || '';
    if (password.length < 8) {
      setError('新密码至少 8 位');
      return;
    }
    const res = await fetch('/api/admin/users/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    showResult(data, `账号 ${username} 的密码已重置`);
    if (data.success) {
      setResetPasswords((prev) => ({ ...prev, [username]: '' }));
    }
  };

  const handleDelete = async (username: string) => {
    if (!window.confirm(`确定删除账号 ${username}？`)) return;
    const res = await fetch('/api/admin/users', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username }),
    });
    const data = await res.json();
    showResult(data, `账号 ${username} 已删除`);
    if (data.success) load();
  };

  const handleToggleRegistration = async () => {
    const res = await fetch('/api/admin/registration', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ open: !registrationOpen }),
    });
    const data = await res.json();
    if (data.success) {
      setRegistrationOpen(data.registrationOpen);
      setMessage(data.registrationOpen ? '注册已开放' : '注册已关闭');
      setError('');
    } else {
      setError(data.message || '操作失败');
    }
  };

  const handleLogout = async () => {
    await fetch('/api/admin/logout', { method: 'POST' });
    window.location.reload();
  };

  return (
    <div className="min-h-screen bg-gray-50 py-10 px-4">
      <div className="max-w-3xl mx-auto space-y-8">
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-bold text-gray-900">族谱管理后台</h2>
          <button
            onClick={handleLogout}
            className="text-sm text-gray-600 hover:text-gray-900 underline"
          >
            退出后台
          </button>
        </div>

        {message && <div className="text-green-600 text-sm">{message}</div>}
        {error && <div className="text-red-500 text-sm">{error}</div>}

        <div className="bg-white rounded-lg shadow p-6 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="font-medium text-gray-900">开放注册</div>
              <div className="text-sm text-gray-500">
                当前状态：{registrationOpen ? '开放（任何人可注册账号）' : '关闭（只能由后台创建账号）'}
              </div>
            </div>
            <button
              onClick={handleToggleRegistration}
              className={`py-2 px-4 rounded-md text-sm font-medium text-white ${registrationOpen ? 'bg-red-500 hover:bg-red-600' : 'bg-green-600 hover:bg-green-700'}`}
            >
              {registrationOpen ? '关闭注册' : '开放注册'}
            </button>
          </div>
        </div>

        <div className="bg-white rounded-lg shadow p-6 space-y-4">
          <div className="font-medium text-gray-900">新建账号（指定账号密码）</div>
          <form onSubmit={handleCreate} className="flex flex-col sm:flex-row gap-3">
            <input
              type="text"
              required
              placeholder="账号"
              className="flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
              value={newUsername}
              onChange={(e) => setNewUsername(e.target.value)}
            />
            <input
              type="text"
              required
              placeholder="密码（至少 8 位）"
              className="flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
            <button
              type="submit"
              className="py-2 px-4 rounded-md text-sm font-medium text-white bg-blue-600 hover:bg-blue-700"
            >
              创建
            </button>
          </form>
        </div>

        <div className="bg-white rounded-lg shadow p-6 space-y-4">
          <div className="font-medium text-gray-900">已有账号（{users.length}）</div>
          {users.length === 0 && <div className="text-sm text-gray-500">暂无账号</div>}
          <ul className="divide-y divide-gray-100">
            {users.map((u) => (
              <li key={u.username} className="py-3 flex flex-col sm:flex-row sm:items-center gap-3">
                <div className="sm:w-40">
                  <div className="font-medium text-gray-900">{u.username}</div>
                  <div className="text-xs text-gray-400">
                    创建于 {new Date(u.createdAt).toLocaleDateString('zh-CN')}
                  </div>
                </div>
                <input
                  type="text"
                  placeholder="输入新密码后点重置"
                  className="flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                  value={resetPasswords[u.username] || ''}
                  onChange={(e) =>
                    setResetPasswords((prev) => ({ ...prev, [u.username]: e.target.value }))
                  }
                />
                <div className="flex gap-2">
                  <button
                    onClick={() => handleReset(u.username)}
                    className="py-2 px-3 rounded-md text-sm bg-amber-500 text-white hover:bg-amber-600"
                  >
                    重置密码
                  </button>
                  <button
                    onClick={() => handleDelete(u.username)}
                    className="py-2 px-3 rounded-md text-sm bg-red-500 text-white hover:bg-red-600"
                  >
                    删除
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
