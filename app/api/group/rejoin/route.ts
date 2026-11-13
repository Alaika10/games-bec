import { NextResponse } from 'next/server';
import { collection, doc, getDoc, getDocs } from 'firebase/firestore';
import { verifySecretHash } from '@/lib/server/crypto';
import {
  ensureDefaultSessionSeeded,
  findSessionByCode,
  serverDb,
} from '@/lib/server/firestore-server';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const sessionCode = String(body?.sessionCode ?? '').trim();
    const groupCode = String(body?.groupCode ?? '')
      .trim()
      .toUpperCase()
      .replace(/\s+/g, '');

    if (!/^\d{4}$/.test(sessionCode)) {
      return NextResponse.json(
        { error: 'Kode Sesi harus 4 digit angka.' },
        { status: 400 }
      );
    }
    if (!/^[A-Z0-9]{4}$/.test(groupCode)) {
      return NextResponse.json(
        { error: 'Kode Kelompok harus 4 karakter.' },
        { status: 400 }
      );
    }

    await ensureDefaultSessionSeeded();
    const session = await findSessionByCode(sessionCode);
    if (!session) {
      return NextResponse.json(
        { error: `Kode Sesi ${sessionCode} tidak ditemukan.` },
        { status: 404 }
      );
    }

    const groupsSnap = await getDocs(
      collection(serverDb, 'sessions', session.id, 'groups')
    );

    for (const gDoc of groupsSnap.docs) {
      const privSnap = await getDoc(
        doc(serverDb, 'sessions', session.id, 'group_private', gDoc.id)
      );
      if (!privSnap.exists()) continue;
      const expectedHash = String(privSnap.data().groupCodeHash || '');
      if (
        verifySecretHash(
          groupCode,
          `group:${session.id}:${gDoc.id}`,
          expectedHash
        )
      ) {
        return NextResponse.json({
          sessionId: session.id,
          sessionCode: session.sessionCode,
          groupId: gDoc.id,
          groupCode,
          teamName: String(gDoc.data().teamName || ''),
        });
      }
    }

    return NextResponse.json(
      { error: 'Kode Kelompok tidak cocok dengan sesi ini.' },
      { status: 401 }
    );
  } catch (error) {
    console.error('Rejoin group error:', error);
    return NextResponse.json(
      { error: 'Gagal masuk kembali ke kelompok.' },
      { status: 500 }
    );
  }
}
