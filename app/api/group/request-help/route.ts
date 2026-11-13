import { NextResponse } from 'next/server';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  where,
  writeBatch,
} from 'firebase/firestore';
import {
  decryptJson,
  deriveGateToken,
  randomId,
  randomNonce,
  verifySecretHash,
} from '@/lib/server/crypto';
import { serverDb } from '@/lib/server/firestore-server';
import {
  GroupDoc,
  SessionDoc,
  UnlockedEmergencyItem,
  UnlockedHintItem,
} from '@/lib/types';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const sessionId = String(body?.sessionId ?? '').trim();
    const groupId = String(body?.groupId ?? '').trim();
    const groupCode = String(body?.groupCode ?? '')
      .trim()
      .toUpperCase();
    const type = body?.type === 'emergency' ? 'emergency' : body?.type === 'hint' ? 'hint' : null;

    if (!sessionId || !groupId || !groupCode || !type) {
      return NextResponse.json(
        { error: 'Permintaan tidak lengkap.' },
        { status: 400 }
      );
    }

    const [sessionSnap, groupSnap, privSnap] = await Promise.all([
      getDoc(doc(serverDb, 'sessions', sessionId)),
      getDoc(doc(serverDb, 'sessions', sessionId, 'groups', groupId)),
      getDoc(doc(serverDb, 'sessions', sessionId, 'group_private', groupId)),
    ]);

    if (!sessionSnap.exists() || !groupSnap.exists() || !privSnap.exists()) {
      return NextResponse.json(
        { error: 'Sesi atau kelompok tidak ditemukan.' },
        { status: 404 }
      );
    }

    const privData = privSnap.data();
    if (
      !verifySecretHash(
        groupCode,
        `group:${sessionId}:${groupId}`,
        String(privData.groupCodeHash || '')
      )
    ) {
      return NextResponse.json(
        { error: 'Kode kelompok tidak valid.' },
        { status: 401 }
      );
    }

    const session = sessionSnap.data() as Omit<SessionDoc, 'id'>;
    const group = groupSnap.data() as Omit<GroupDoc, 'id'>;

    if (session.status === 'waiting') {
      return NextResponse.json(
        { error: 'Sesi belum dimulai.' },
        { status: 400 }
      );
    }
    if (session.status === 'ended') {
      return NextResponse.json(
        { error: 'Sesi sudah berakhir.' },
        { status: 403 }
      );
    }
    if (group.currentSheet > session.totalSheets) {
      return NextResponse.json(
        { error: 'Kelompok sudah menyelesaikan semua lembar.' },
        { status: 400 }
      );
    }

    if (type === 'hint') {
      const unlockedHints = decryptJson<UnlockedHintItem[]>(
        String(privData.unlockedHintsCipher)
      );
      if (unlockedHints.some((h) => h.sheetNumber === group.currentSheet)) {
        return NextResponse.json(
          { error: 'Petunjuk untuk lembar ini sudah terbuka.' },
          { status: 400 }
        );
      }
    } else {
      const unlockedEmerg = decryptJson<UnlockedEmergencyItem[]>(
        String(privData.unlockedEmergencyCipher)
      );
      if (unlockedEmerg.some((e) => e.sheetNumber === group.currentSheet)) {
        return NextResponse.json(
          { error: 'Kunci darurat untuk lembar ini sudah diberikan.' },
          { status: 400 }
        );
      }
    }

    const existingReqSnap = await getDocs(
      query(
        collection(serverDb, 'sessions', sessionId, 'requests'),
        where('groupId', '==', groupId)
      )
    );
    const hasPendingSame = existingReqSnap.docs.some((d) => {
      const data = d.data();
      return (
        data.status === 'pending' &&
        data.type === type &&
        data.sheetNumber === group.currentSheet
      );
    });

    if (hasPendingSame) {
      return NextResponse.json({
        alreadyPending: true,
        message: 'Permintaan sudah terkirim. Menunggu persetujuan admin.',
      });
    }

    const now = Date.now();
    const requestId = randomId('req');
    const batch = writeBatch(serverDb);

    batch.update(doc(serverDb, 'sessions', sessionId, 'server_gate', 'main'), {
      gateToken: deriveGateToken(sessionId),
      nonce: randomNonce(),
      updatedAtMs: now,
    });

    batch.set(doc(serverDb, 'sessions', sessionId, 'requests', requestId), {
      groupId,
      teamName: group.teamName,
      type,
      sheetNumber: group.currentSheet,
      status: 'pending',
      createdAtMs: now,
      resolvedAtMs: 0,
    });

    await batch.commit();

    return NextResponse.json({
      requestId,
      status: 'pending',
      type,
      sheetNumber: group.currentSheet,
    });
  } catch (error) {
    console.error('Request help error:', error);
    return NextResponse.json(
      { error: 'Gagal mengirim permintaan bantuan.' },
      { status: 500 }
    );
  }
}
