import { NextResponse } from 'next/server';
import { collection, getDocs, query, where } from 'firebase/firestore';
import {
  ensureDefaultSessionSeeded,
  serverDb,
} from '@/lib/server/firestore-server';
import { SessionDoc } from '@/lib/types';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await ensureDefaultSessionSeeded();
    const snap = await getDocs(
      query(collection(serverDb, 'sessions'), where('sessionCode', '>=', '0000'))
    );
    const sessions = snap.docs
      .filter((d) => !d.id.startsWith('_probe'))
      .map((d) => {
        const data = d.data() as Omit<SessionDoc, 'id'>;
        return {
          id: d.id,
          sessionCode: data.sessionCode,
          title: data.title,
          status: data.status,
          createdAtMs: data.createdAtMs,
        };
      })
      .sort((a, b) => b.createdAtMs - a.createdAtMs);

    return NextResponse.json({
      sessions,
      serverNowMs: Date.now(),
    });
  } catch (error) {
    console.error('List sessions error:', error);
    return NextResponse.json(
      { error: 'Gagal memuat daftar sesi.' },
      { status: 500 }
    );
  }
}
