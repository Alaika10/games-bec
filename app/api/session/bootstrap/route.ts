import { NextResponse } from 'next/server';
import {
  ensureDefaultSessionSeeded,
  findSessionByCode,
} from '@/lib/server/firestore-server';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const code = searchParams.get('code');

    let session = code ? await findSessionByCode(code) : null;
    if (!session) {
      session = await ensureDefaultSessionSeeded();
    }

    return NextResponse.json({
      sessionId: session.id,
      sessionCode: session.sessionCode,
      title: session.title,
      status: session.status,
      totalSheets: session.totalSheets,
      serverNowMs: Date.now(),
    });
  } catch (error) {
    console.error('Bootstrap session error:', error);
    return NextResponse.json(
      { error: 'Gagal memuat sesi permainan.' },
      { status: 500 }
    );
  }
}
