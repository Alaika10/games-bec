import { NextResponse } from 'next/server';
import {
  ensureDefaultSessionSeeded,
  findSessionByCode,
} from '@/lib/server/firestore-server';
import { verifyAdminPinForSession } from '@/lib/server/admin-auth';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const sessionCode = String(body?.sessionCode ?? '').trim();
    const pin = String(body?.pin ?? '').trim();

    if (!pin) {
      return NextResponse.json(
        { error: 'Masukkan PIN admin.' },
        { status: 400 }
      );
    }

    const defaultSession = await ensureDefaultSessionSeeded();
    const session = sessionCode
      ? await findSessionByCode(sessionCode)
      : defaultSession;

    if (!session) {
      return NextResponse.json(
        { error: `Kode Sesi ${sessionCode} tidak ditemukan.` },
        { status: 404 }
      );
    }

    const valid = await verifyAdminPinForSession(session.id, pin);
    if (!valid) {
      return NextResponse.json(
        { error: 'PIN admin salah.' },
        { status: 401 }
      );
    }

    return NextResponse.json({
      ok: true,
      sessionId: session.id,
      sessionCode: session.sessionCode,
    });
  } catch (error) {
    console.error('Admin auth error:', error);
    return NextResponse.json(
      { error: 'Gagal memverifikasi PIN admin.' },
      { status: 500 }
    );
  }
}
