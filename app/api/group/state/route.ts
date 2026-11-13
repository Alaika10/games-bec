import { NextResponse } from 'next/server';
import { doc, getDoc } from 'firebase/firestore';
import { decryptJson, verifySecretHash } from '@/lib/server/crypto';
import {
  getGroupPointsFromLogs,
  serverDb,
} from '@/lib/server/firestore-server';
import {
  GroupDoc,
  GroupPrivateStateResponse,
  SessionDoc,
  SheetConfigItem,
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

    if (!sessionId || !groupId || !groupCode) {
      return NextResponse.json(
        { error: 'Parameter kelompok tidak lengkap.' },
        { status: 400 }
      );
    }

    const [sessionSnap, secretSnap, groupSnap, privSnap] = await Promise.all([
      getDoc(doc(serverDb, 'sessions', sessionId)),
      getDoc(doc(serverDb, 'sessions', sessionId, 'secrets', 'config')),
      getDoc(doc(serverDb, 'sessions', sessionId, 'groups', groupId)),
      getDoc(doc(serverDb, 'sessions', sessionId, 'group_private', groupId)),
    ]);

    if (!sessionSnap.exists() || !secretSnap.exists()) {
      return NextResponse.json(
        { error: 'Sesi tidak ditemukan atau sudah di-reset.' },
        { status: 404 }
      );
    }
    if (!groupSnap.exists() || !privSnap.exists()) {
      return NextResponse.json(
        { error: 'Data kelompok tidak ditemukan.' },
        { status: 404 }
      );
    }

    const privData = privSnap.data();
    const valid = verifySecretHash(
      groupCode,
      `group:${sessionId}:${groupId}`,
      String(privData.groupCodeHash || '')
    );
    if (!valid) {
      return NextResponse.json(
        { error: 'Kode kelompok tidak valid.' },
        { status: 401 }
      );
    }

    const sessionData = sessionSnap.data() as Omit<SessionDoc, 'id'>;
    const groupData = groupSnap.data() as Omit<GroupDoc, 'id'>;
    const sheets = decryptJson<SheetConfigItem[]>(
      String(secretSnap.data().sheetsCipher)
    );
    const unlockedHints = decryptJson<UnlockedHintItem[]>(
      String(privData.unlockedHintsCipher)
    );
    const unlockedEmergencyKeys = decryptJson<UnlockedEmergencyItem[]>(
      String(privData.unlockedEmergencyCipher)
    );

    const logPoints = await getGroupPointsFromLogs(sessionId, groupId);

    let currentSheetCode: string | null = null;
    if (
      sessionData.status !== 'waiting' &&
      groupData.currentSheet >= 1 &&
      groupData.currentSheet <= sessionData.totalSheets
    ) {
      const sheetObj = sheets.find(
        (s) => s.sheetNumber === groupData.currentSheet
      );
      currentSheetCode = sheetObj ? sheetObj.sheetCode : null;
    }

    const payload: GroupPrivateStateResponse = {
      groupId,
      groupCode,
      teamName: groupData.teamName,
      members: groupData.members,
      points: logPoints,
      currentSheet: groupData.currentSheet,
      completedSheets: groupData.completedSheets,
      totalSheets: sessionData.totalSheets,
      currentSheetCode,
      unlockedHints,
      unlockedEmergencyKeys,
      cooldownUntilMs: groupData.cooldownUntilMs,
      serverNowMs: Date.now(),
    };

    return NextResponse.json(payload);
  } catch (error) {
    console.error('Group state error:', error);
    return NextResponse.json(
      { error: 'Gagal memuat status kelompok.' },
      { status: 500 }
    );
  }
}
