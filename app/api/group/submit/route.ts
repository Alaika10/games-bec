import { NextResponse } from 'next/server';
import { doc, runTransaction } from 'firebase/firestore';
import {
  computePointsFromDeltas,
  computeRemainingSeconds,
  normalizeAnswerKey,
} from '@/lib/game-utils';
import {
  decryptJson,
  deriveGateToken,
  randomId,
  randomNonce,
  verifySecretHash,
} from '@/lib/server/crypto';
import {
  getGroupLogsOrdered,
  serverDb,
} from '@/lib/server/firestore-server';
import {
  GroupDoc,
  SessionDoc,
  SheetConfigItem,
  UnlockedEmergencyItem,
} from '@/lib/types';

class ApiError extends Error {
  status: number;
  extra?: Record<string, unknown>;
  constructor(message: string, status: number, extra?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const sessionId = String(body?.sessionId ?? '').trim();
    const groupId = String(body?.groupId ?? '').trim();
    const groupCode = String(body?.groupCode ?? '')
      .trim()
      .toUpperCase();
    const rawInput = String(body?.answerInput ?? '');
    const normalizedInput = normalizeAnswerKey(rawInput);

    if (!sessionId || !groupId || !groupCode) {
      return NextResponse.json(
        { error: 'Sesi kelompok tidak valid.' },
        { status: 400 }
      );
    }
    if (!normalizedInput) {
      return NextResponse.json(
        { error: 'Masukkan kode kunci terlebih dahulu.' },
        { status: 400 }
      );
    }

    const existingLogs = await getGroupLogsOrdered(sessionId, groupId);
    const logBasePoints = computePointsFromDeltas(existingLogs.map((l) => l.delta));

    const sessionRef = doc(serverDb, 'sessions', sessionId);
    const secretRef = doc(serverDb, 'sessions', sessionId, 'secrets', 'config');
    const groupRef = doc(serverDb, 'sessions', sessionId, 'groups', groupId);
    const privRef = doc(serverDb, 'sessions', sessionId, 'group_private', groupId);
    const gateRef = doc(serverDb, 'sessions', sessionId, 'server_gate', 'main');

    const result = await runTransaction(serverDb, async (tx) => {
      const [sessionSnap, secretSnap, groupSnap, privSnap] = await Promise.all([
        tx.get(sessionRef),
        tx.get(secretRef),
        tx.get(groupRef),
        tx.get(privRef),
      ]);

      if (!sessionSnap.exists() || !secretSnap.exists()) {
        throw new ApiError('Sesi tidak ditemukan.', 404);
      }
      if (!groupSnap.exists() || !privSnap.exists()) {
        throw new ApiError('Kelompok tidak ditemukan.', 404);
      }

      const privData = privSnap.data();
      if (
        !verifySecretHash(
          groupCode,
          `group:${sessionId}:${groupId}`,
          String(privData.groupCodeHash || '')
        )
      ) {
        throw new ApiError('Kode kelompok tidak valid.', 401);
      }

      const session = sessionSnap.data() as Omit<SessionDoc, 'id'>;
      const group = groupSnap.data() as Omit<GroupDoc, 'id'>;
      const secretData = secretSnap.data();

      if (session.status === 'waiting') {
        throw new ApiError('Sesi belum dimulai oleh admin.', 400);
      }
      if (session.status === 'paused') {
        throw new ApiError('Sesi sedang dijeda oleh admin.', 400);
      }
      if (session.status === 'ended') {
        throw new ApiError('Sesi sudah diakhiri.', 403);
      }
      if (group.currentSheet > session.totalSheets) {
        throw new ApiError('Semua kunci sudah berhasil dibuka!', 400);
      }

      const now = Date.now();

      if (group.lastSubmitAtMs && now - group.lastSubmitAtMs < 2000) {
        throw new ApiError(
          'Terlalu cepat. Tunggu 2 detik sebelum mengirim lagi.',
          429
        );
      }

      if (group.cooldownUntilMs && now < group.cooldownUntilMs) {
        const waitSec = Math.ceil((group.cooldownUntilMs - now) / 1000);
        throw new ApiError(
          `Tombol terkunci. Tunggu ${waitSec} detik lagi.`,
          429,
          { cooldownUntilMs: group.cooldownUntilMs, serverNowMs: now }
        );
      }

      const unlockedEmergency = decryptJson<UnlockedEmergencyItem[]>(
        String(privData.unlockedEmergencyCipher)
      );
      const hasEmergencyForSheet = unlockedEmergency.some(
        (e) => e.sheetNumber === group.currentSheet
      );

      const remainingSec = computeRemainingSeconds(session, now);
      if (remainingSec <= 0 && !hasEmergencyForSheet) {
        throw new ApiError(
          'Waktu sesi habis! Minta Kunci Darurat dari admin untuk melanjutkan.',
          403
        );
      }

      const sheets = decryptJson<SheetConfigItem[]>(String(secretData.sheetsCipher));
      const sheetIndex = group.currentSheet;
      const targetSheet = sheets.find((s) => s.sheetNumber === sheetIndex);
      if (!targetSheet) {
        throw new ApiError('Konfigurasi lembar tidak ditemukan.', 500);
      }

      const baseBalance = existingLogs.length > 0 ? logBasePoints : group.points;
      const isCorrect = normalizedInput === targetSheet.normalizedKey;

      if (!isCorrect) {
        const delta = session.pointsWrong;
        const newPoints = Math.max(0, baseBalance + delta);
        const cooldownUntilMs = now + 10000;
        const logId = randomId('log');
        const activityText = `Kode salah pada Lembar ${sheetIndex} (${delta} poin)`;

        tx.update(gateRef, {
          gateToken: deriveGateToken(sessionId),
          nonce: randomNonce(),
          updatedAtMs: now,
        });

        tx.update(groupRef, {
          points: newPoints,
          cooldownUntilMs,
          lastSubmitAtMs: now,
          lastActivityText: activityText,
          lastActivityAtMs: now,
          updatedAtMs: now,
        });

        tx.set(doc(serverDb, 'sessions', sessionId, 'logs', logId), {
          groupId,
          teamName: group.teamName,
          action: `Kode salah (Lembar ${sheetIndex})`,
          reason: `Input tidak cocok`,
          delta,
          balanceAfter: newPoints,
          sheetNumber: sheetIndex,
          createdAtMs: now,
        });

        return {
          correct: false,
          delta,
          newPoints,
          cooldownUntilMs,
          serverNowMs: now,
        };
      }

      // Correct key!
      const fastestField = `fastest${sheetIndex}` as
        | 'fastest1'
        | 'fastest2'
        | 'fastest3'
        | 'fastest4'
        | 'fastest5';
      const isFirstOnSheet = !String(secretData[fastestField] || '');
      const isFinalSheet = sheetIndex === session.totalSheets;

      const baseDelta = session.pointsCorrect;
      const afterBase = Math.max(0, baseBalance + baseDelta);

      let bonusDelta = 0;
      let bonusAction = '';
      if (isFirstOnSheet) {
        if (isFinalSheet) {
          bonusDelta = session.pointsFinalFirst;
          bonusAction = 'Bonus Pertama Kata Final';
        } else {
          bonusDelta = session.pointsFastest;
          bonusAction = `Bonus Tercepat Lembar ${sheetIndex}`;
        }
      }

      const finalBalance = Math.max(0, afterBase + bonusDelta);
      const nextSheet = sheetIndex + 1;
      const completedSheets = sheetIndex;
      const vaultOpened = nextSheet > session.totalSheets;
      const nextSheetObj = sheets.find((s) => s.sheetNumber === nextSheet);

      const activityText = vaultOpened
        ? `BRANKAS TERBUKA! Semua kunci selesai (+${baseDelta + bonusDelta} poin)`
        : `Membuka kunci Lembar ${sheetIndex} (+${baseDelta + bonusDelta} poin)`;

      tx.update(gateRef, {
        gateToken: deriveGateToken(sessionId),
        nonce: randomNonce(),
        updatedAtMs: now,
      });

      if (isFirstOnSheet) {
        tx.update(secretRef, {
          [fastestField]: groupId,
          updatedAtMs: now,
        });
      }

      tx.update(groupRef, {
        points: finalBalance,
        currentSheet: nextSheet,
        completedSheets,
        finishedAtMs: vaultOpened ? now : group.finishedAtMs,
        cooldownUntilMs: 0,
        lastSubmitAtMs: now,
        lastActivityText: activityText,
        lastActivityAtMs: now,
        updatedAtMs: now,
      });

      const eventId = randomId('evt');
      tx.update(sessionRef, {
        lastEventId: eventId,
        lastEventType: vaultOpened ? 'vault' : 'unlock',
        lastEventTeam: group.teamName,
        lastEventMessage: vaultOpened
          ? `TIM ${group.teamName} MEMBUKA BRANKAS!`
          : `TIM ${group.teamName} MEMBUKA KUNCI!`,
        lastEventAtMs: now,
        updatedAtMs: now,
      });

      const log1Id = randomId('log');
      tx.set(doc(serverDb, 'sessions', sessionId, 'logs', log1Id), {
        groupId,
        teamName: group.teamName,
        action: isFinalSheet
          ? 'Kata final benar'
          : `Kunci Lembar ${sheetIndex} benar`,
        reason: `Kode lembar ${targetSheet.sheetCode}`,
        delta: baseDelta,
        balanceAfter: afterBase,
        sheetNumber: sheetIndex,
        createdAtMs: now,
      });

      if (bonusDelta > 0) {
        const log2Id = randomId('log');
        tx.set(doc(serverDb, 'sessions', sessionId, 'logs', log2Id), {
          groupId,
          teamName: group.teamName,
          action: bonusAction,
          reason: `Kelompok pertama menyelesaikan Lembar ${sheetIndex}`,
          delta: bonusDelta,
          balanceAfter: finalBalance,
          sheetNumber: sheetIndex,
          createdAtMs: now + 1,
        });
      }

      return {
        correct: true,
        vaultOpened,
        pointsAwarded: baseDelta + bonusDelta,
        baseAwarded: baseDelta,
        bonusAwarded: bonusDelta,
        newPoints: finalBalance,
        currentSheet: nextSheet,
        completedSheets,
        nextSheetCode: !vaultOpened && nextSheetObj ? nextSheetObj.sheetCode : null,
        serverNowMs: now,
      };
    });

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof ApiError) {
      return NextResponse.json(
        { error: error.message, ...(error.extra || {}) },
        { status: error.status }
      );
    }
    console.error('Submit key error:', error);
    return NextResponse.json(
      { error: 'Terjadi kesalahan saat memeriksa kode kunci.' },
      { status: 500 }
    );
  }
}
