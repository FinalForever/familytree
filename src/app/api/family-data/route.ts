import { NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { getAuthConfigOnServer } from '@/utils/config';
import { extractToken, verifyToken } from '@/utils/auth';

export async function GET(request: Request) {
  try {
    // 开启鉴权时必须携带有效签名令牌（Authorization 头或 HttpOnly Cookie）
    const authConfig = await getAuthConfigOnServer();
    if (authConfig.requireAuth && !verifyToken(extractToken(request))) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const configPath = path.join(process.cwd(), 'config', 'family-data.json');

    if (!fs.existsSync(configPath)) {
      console.warn('family-data.json not found, returning empty data');
      return NextResponse.json({
        generations: []
      });
    }

    const fileContent = fs.readFileSync(configPath, 'utf8');
    const data = JSON.parse(fileContent);
    return NextResponse.json(data);
  } catch (error) {
    console.error('Error loading family data:', error);
    return NextResponse.json(
      { error: 'Failed to load family data' },
      { status: 500 }
    );
  }
}
