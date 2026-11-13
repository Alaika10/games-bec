import { NextResponse } from 'next/server';
import { doc, getDoc, runTransaction } from 'firebase/firestore';
import { computePointsFromDeltas } from '@/lib/game-utils';
import {
  decryptJson,
  deriveGateToken,
  encryptJson,
  randomId,
  randomNonce,
} from '@/lib/server/crypto';
import { verifyAdminPinForSession } from '@/lib/server/admin-auth';
import { getGroupLogsOrdered, serverDb } from '@/lib/server/firestore-server';
import {
  GroupDoc,
  HelpRequestDoc,
  SessionDoc,
  SheetConfigItem,
  UnlockedEmergencyItem,
  UnlockedHintItem,
} from '@/lib/types';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const sessionId = String(body?.sessionId ?? '').trim();
    const pin = String(body?.pin ?? '').trim();
    const requestId = String(body?.requestId ?? '').trim();
    const decision =
      body?.decision === 'approve'
        ? 'approve'
        : body?.decision === 'reject'
          ? 'reject'
          : null;

    if (!sessionId || !pin || !requestId || !decision) {
      return NextResponse.json(
        { error: 'Parameter permintaan tidak lengkap.' },
        { status: 400 }
      );
    }

    const valid = await verifyAdminPinForSession(sessionId, pin);
    if (!valid) {
      return NextResponse.json(
        { error: 'PIN admin salah.' },
        { status: 401 }
      );
    }

    const reqRef = doc(serverDb, 'sessions', sessionId, 'requests', requestId);
    const reqPreSnap = await getDoc(reqRef);
    if (!reqPreSnap.exists()) {
      return NextResponse.json(
        { error: 'Permintaan tidak ditemukan.' },
        { status: 404 }
      );
    }
    const reqPre = reqPreSnap.data() as Omit<HelpRequestDoc, 'id'>;
    const existingLogs = await getGroupLogsOrdered(sessionId, reqPre.groupId);
    const basePoints = computePointsFromDeltas(existingLogs.map((l) => l.delta));

    const sessionRef = doc(serverDb, 'sessions', sessionId);
    const secretRef = doc(serverDb, 'sessions', sessionId, 'secrets', 'config');
    const groupRef = doc(serverDb, 'sessions', sessionId, 'groups', reqPre.groupId);
    const privRef = doc(serverDb, 'sessions', sessionId, 'group_private', reqPre.groupId);
    const gateRef = doc(serverDb, 'sessions', sessionId, 'server_gate', 'main');

    const now = Date.now();

    await runTransaction(serverDb, async (tx) => {
      const [sessionSnap, secretSnap, groupSnap, privSnap, reqSnap] =
        await Promise.all([
          tx.get(sessionRef),
          tx.get(secretRef),
          tx.get(groupRef),
          tx.get(privRef),
          tx.get(reqRef),
        ]);

      if (!sessionSnap.exists() || !secretSnap.exists() || !reqSnap.exists()) {
        throw new Error('Data permintaan atau sesi tidak ditemukan.');
      }

      const reqData = reqSnap.data() as Omit<HelpRequestDoc, 'id'>;
      if (reqData.status !== 'pending') {
        throw new Error('Permintaan ini sudah diproses sebelumnya.');
      }

      tx.update(gateRef, {
        gateToken: deriveGateToken(sessionId),
        nonce: randomNonce(),
        updatedAtMs: now,
      });

      if (decision === 'reject') {
        tx.update(reqRef, {
          status: 'rejected',
          resolvedAtMs: now,
        });
        return;
      }

      if (!groupSnap.exists() || !privSnap.exists()) {
        throw new Error('Kelompok tidak ditemukan.');
      }

      const session = sessionSnap.data() as Omit<SessionDoc, 'id'>;
      const group = groupSnap.data() as Omit<GroupDoc, 'id'>;
      const privData = privSnap.data();
      const sheets = decryptJson<SheetConfigItem[]>(
        String(secretSnap.data().sheetsCipher)
      );
      const targetSheet = sheets.find((s) => s.sheetNumber === reqData.sheetNumber);
      if (!targetSheet) {
        throw new Error('Lembar tidak ditemukan.');
      }

      const currentBalance = existingLogs.length > 0 ? basePoints : group.points;
      const delta =
        reqData.type === 'hint' ? session.pointsHint : session.pointsEmergency;
      const newPoints = Math.max(0, currentBalance + delta);
      const logId = randomId('log');

      if (reqData.type === 'hint') {
        const unlockedHints = decryptJson<UnlockedHintItem[]>(
          String(privData.unlockedHintsCipher)
        );
        if (!unlockedHints.some((h) => h.sheetNumber === reqData.sheetNumber)) {
          unlockedHints.push({
            sheetNumber: reqData.sheetNumber,
            hintText: targetSheet.hintText,
            unlockedAtMs: now,
          });
        }
        tx.update(privRef, {
          unlockedHintsCipher: encryptJson(unlockedHints),
          updatedAtMs: now,
        });
      } else {
        const unlockedEmergency = decryptJson<UnlockedEmergencyItem[]>(
          String(privData.unlockedEmergencyCipher)
        );
        if (!unlockedEmergency.some((e) => e.sheetNumber === reqData.sheetNumber)) {
          unlockedEmergency.push({
            sheetNumber: reqData.sheetNumber,
            keyValue: targetSheet.normalizedKey,
            unlockedAtMs: now,
          });
        }
        tx.update(privRef, {
          unlockedEmergencyCipher: encryptJson(unlockedEmergency),
          updatedAtMs: now,
        });
      }

      const label =
        reqData.type === 'hint'
          ? `Petunjuk Lembar ${reqData.sheetNumber}`
          : `Kunci Darurat Lembar ${reqData.sheetNumber}`;

      tx.update(reqRef, {
        status: 'approved',
        resolvedAtMs: now,
      });

      tx.update(groupRef, {
        points: newPoints,
        lastActivityText: `${label} disetujui (${delta} poin)`,
        lastActivityAtMs: now,
        updatedAtMs: now,
      });

      tx.set(doc(serverDb, 'sessions', sessionId, 'logs', logId), {
        groupId: reqData.groupId,
        teamName: group.teamName,
        action: `${label} disetujui`,
        reason: 'Persetujuan admin',
        delta,
        balanceAfter: newPoints,
        sheetNumber: reqData.sheetNumber,
        createdAtMs: now,
      });
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('Admin request decision error:', error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : 'Gagal memproses permintaan.',
      },
      { status: 500 }
    );
  }
}
