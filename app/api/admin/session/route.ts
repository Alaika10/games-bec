import { NextResponse } from 'next/server';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  writeBatch,
} from 'firebase/firestore';
import {
  computeRemainingSeconds,
  normalizeAnswerKey,
} from '@/lib/game-utils';
import {
  deriveGateToken,
  encryptJson,
  hashSecret,
  randomId,
  randomNonce,
} from '@/lib/server/crypto';
import { verifyAdminPinForSession } from '@/lib/server/admin-auth';
import {
  createSessionRecord,
  DEFAULT_SEED_SHEETS,
  findSessionByCode,
  serverDb,
} from '@/lib/server/firestore-server';
import { SessionDoc, SheetConfigItem } from '@/lib/types';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const sessionId = String(body?.sessionId ?? '').trim();
    const pin = String(body?.pin ?? '').trim();
    const action = String(body?.action ?? '').trim();
    const payload = body?.payload || {};

    if (!sessionId || !pin || !action) {
      return NextResponse.json(
        { error: 'Permintaan admin tidak lengkap.' },
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

    const now = Date.now();

    if (action === 'create') {
      const newCode = String(payload.sessionCode ?? '').trim();
      const newTitle = String(payload.title ?? 'HACK THE SYSTEM: Reading Escape Room').trim();
      const newPin = String(payload.adminPin ?? pin).trim();
      const durationMinutes = Number(payload.durationMinutes ?? 85);

      if (!/^\d{4}$/.test(newCode)) {
        return NextResponse.json(
          { error: 'Kode Sesi baru harus 4 digit angka.' },
          { status: 400 }
        );
      }
      if (newPin.length < 4 || newPin.length > 20) {
        return NextResponse.json(
          { error: 'PIN admin minimal 4 karakter.' },
          { status: 400 }
        );
      }
      const existing = await findSessionByCode(newCode);
      if (existing) {
        return NextResponse.json(
          { error: `Kode Sesi ${newCode} sudah digunakan.` },
          { status: 409 }
        );
      }

      const created = await createSessionRecord({
        sessionCode: newCode,
        title: newTitle,
        adminPin: newPin,
        durationMinutes: Number.isFinite(durationMinutes) ? durationMinutes : 85,
        sheets: DEFAULT_SEED_SHEETS,
      });

      return NextResponse.json({
        ok: true,
        newSessionId: created.id,
        newSessionCode: created.sessionCode,
        newPin,
      });
    }

    const sessionRef = doc(serverDb, 'sessions', sessionId);
    const secretRef = doc(serverDb, 'sessions', sessionId, 'secrets', 'config');
    const gateRef = doc(serverDb, 'sessions', sessionId, 'server_gate', 'main');

    const [sessionSnap, secretSnap] = await Promise.all([
      getDoc(sessionRef),
      getDoc(secretRef),
    ]);
    if (!sessionSnap.exists() || !secretSnap.exists()) {
      return NextResponse.json(
        { error: 'Sesi tidak ditemukan.' },
        { status: 404 }
      );
    }

    const session = sessionSnap.data() as Omit<SessionDoc, 'id'>;

    if (action === 'start') {
      const batch = writeBatch(serverDb);
      batch.update(gateRef, {
        gateToken: deriveGateToken(sessionId),
        nonce: randomNonce(),
        updatedAtMs: now,
      });
      batch.update(sessionRef, {
        status: 'running',
        remainingSecondsAtPause: session.durationSeconds,
        startedAtMs: now,
        endedAtMs: 0,
        lastEventId: randomId('evt'),
        lastEventType: 'status',
        lastEventTeam: '',
        lastEventMessage: 'MISI DIMULAI! CARI LEMBAR PERTAMA!',
        lastEventAtMs: now,
        updatedAtMs: now,
      });
      await batch.commit();
      return NextResponse.json({ ok: true });
    }

    if (action === 'pause') {
      const remaining = computeRemainingSeconds(session, now);
      const batch = writeBatch(serverDb);
      batch.update(gateRef, {
        gateToken: deriveGateToken(sessionId),
        nonce: randomNonce(),
        updatedAtMs: now,
      });
      batch.update(sessionRef, {
        status: 'paused',
        remainingSecondsAtPause: remaining,
        startedAtMs: 0,
        lastEventId: randomId('evt'),
        lastEventType: 'status',
        lastEventTeam: '',
        lastEventMessage: 'SESI DIJEDA SEMENTARA OLEH ADMIN',
        lastEventAtMs: now,
        updatedAtMs: now,
      });
      await batch.commit();
      return NextResponse.json({ ok: true });
    }

    if (action === 'resume') {
      const batch = writeBatch(serverDb);
      batch.update(gateRef, {
        gateToken: deriveGateToken(sessionId),
        nonce: randomNonce(),
        updatedAtMs: now,
      });
      batch.update(sessionRef, {
        status: 'running',
        startedAtMs: now,
        lastEventId: randomId('evt'),
        lastEventType: 'status',
        lastEventTeam: '',
        lastEventMessage: 'SESI DILANJUTKAN!',
        lastEventAtMs: now,
        updatedAtMs: now,
      });
      await batch.commit();
      return NextResponse.json({ ok: true });
    }

    if (action === 'end') {
      const batch = writeBatch(serverDb);
      batch.update(gateRef, {
        gateToken: deriveGateToken(sessionId),
        nonce: randomNonce(),
        updatedAtMs: now,
      });
      batch.update(sessionRef, {
        status: 'ended',
        remainingSecondsAtPause: 0,
        startedAtMs: 0,
        endedAtMs: now,
        lastEventId: randomId('evt'),
        lastEventType: 'status',
        lastEventTeam: '',
        lastEventMessage: 'WAKTU HABIS — SESI BERAKHIR!',
        lastEventAtMs: now,
        updatedAtMs: now,
      });
      await batch.commit();
      return NextResponse.json({ ok: true });
    }

    if (action === 'reset') {
      const [groupsSnap, reqSnap, logsSnap] = await Promise.all([
        getDocs(collection(serverDb, 'sessions', sessionId, 'groups')),
        getDocs(collection(serverDb, 'sessions', sessionId, 'requests')),
        getDocs(collection(serverDb, 'sessions', sessionId, 'logs')),
      ]);

      const allRefs = [
        ...groupsSnap.docs.map((d) => d.ref),
        ...groupsSnap.docs.map((d) =>
          doc(serverDb, 'sessions', sessionId, 'group_private', d.id)
        ),
        ...reqSnap.docs.map((d) => d.ref),
        ...logsSnap.docs.map((d) => d.ref),
      ];

      // Delete in chunks of 8 to stay strictly under Firestore per-batch security rule lookup limit
      for (let i = 0; i < allRefs.length; i += 8) {
        const chunk = allRefs.slice(i, i + 8);
        const delBatch = writeBatch(serverDb);
        delBatch.update(gateRef, {
          gateToken: deriveGateToken(sessionId),
          nonce: randomNonce(),
          updatedAtMs: now,
        });
        for (const ref of chunk) {
          delBatch.delete(ref);
        }
        await delBatch.commit();
      }

      const batch = writeBatch(serverDb);
      batch.update(gateRef, {
        gateToken: deriveGateToken(sessionId),
        nonce: randomNonce(),
        updatedAtMs: now + 1,
      });
      batch.update(secretRef, {
        fastest1: '',
        fastest2: '',
        fastest3: '',
        fastest4: '',
        fastest5: '',
        updatedAtMs: now,
      });
      batch.update(sessionRef, {
        status: 'waiting',
        remainingSecondsAtPause: session.durationSeconds,
        startedAtMs: 0,
        endedAtMs: 0,
        lastEventId: '',
        lastEventType: 'none',
        lastEventTeam: '',
        lastEventMessage: '',
        lastEventAtMs: 0,
        updatedAtMs: now,
      });
      await batch.commit();
      return NextResponse.json({ ok: true });
    }

    if (action === 'update_config') {
      const rawSheets: SheetConfigItem[] = Array.isArray(payload.sheets)
        ? payload.sheets
        : [];
      if (rawSheets.length !== 5) {
        return NextResponse.json(
          { error: 'Harus ada tepat 5 lembar teks.' },
          { status: 400 }
        );
      }
      const cleanSheets: SheetConfigItem[] = rawSheets.map((s, idx) => {
        const sheetCode = String(s.sheetCode ?? '').trim().toUpperCase();
        const normalizedKey = normalizeAnswerKey(String(s.normalizedKey ?? ''));
        const hintText = String(s.hintText ?? '').trim();
        if (!sheetCode || !normalizedKey || !hintText) {
          throw new Error(`Lembar ${idx + 1} belum lengkap.`);
        }
        return {
          sheetNumber: idx + 1,
          sheetCode,
          normalizedKey,
          hintText,
        };
      });

      const durationMinutes = Number(payload.durationMinutes ?? Math.round(session.durationSeconds / 60));
      const newDurationSeconds = Math.max(60, Math.min(86400, Math.round(durationMinutes * 60)));

      const pointsCorrect = Math.max(0, Math.min(1000, Math.round(Number(payload.pointsCorrect ?? session.pointsCorrect))));
      const pointsFastest = Math.max(0, Math.min(1000, Math.round(Number(payload.pointsFastest ?? session.pointsFastest))));
      const pointsFinalFirst = Math.max(0, Math.min(1000, Math.round(Number(payload.pointsFinalFirst ?? session.pointsFinalFirst))));
      const pointsWrong = Math.min(0, Math.max(-1000, Math.round(Number(payload.pointsWrong ?? session.pointsWrong))));
      const pointsHint = Math.min(0, Math.max(-1000, Math.round(Number(payload.pointsHint ?? session.pointsHint))));
      const pointsEmergency = Math.min(0, Math.max(-1000, Math.round(Number(payload.pointsEmergency ?? session.pointsEmergency))));

      const newTitle = String(payload.title ?? session.title).trim().slice(0, 100) || session.title;
      const newPin = String(payload.newPin ?? '').trim();

      const batch = writeBatch(serverDb);
      batch.update(gateRef, {
        gateToken: deriveGateToken(sessionId),
        nonce: randomNonce(),
        updatedAtMs: now,
      });

      const secretUpdate: Record<string, unknown> = {
        sheetsCipher: encryptJson(cleanSheets),
        updatedAtMs: now,
      };
      if (newPin.length >= 4) {
        secretUpdate.adminPinHash = hashSecret(newPin, `admin:${sessionId}`);
      }
      batch.update(secretRef, secretUpdate);

      const sessionUpdate: Record<string, unknown> = {
        title: newTitle,
        durationSeconds: newDurationSeconds,
        pointsCorrect,
        pointsFastest,
        pointsFinalFirst,
        pointsWrong,
        pointsHint,
        pointsEmergency,
        updatedAtMs: now,
      };
      if (session.status === 'waiting') {
        sessionUpdate.remainingSecondsAtPause = newDurationSeconds;
      }
      batch.update(sessionRef, sessionUpdate);

      await batch.commit();
      return NextResponse.json({ ok: true, sheets: cleanSheets });
    }

    return NextResponse.json(
      { error: 'Aksi sesi tidak dikenali.' },
      { status: 400 }
    );
  } catch (error) {
    console.error('Admin session action error:', error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : 'Gagal menjalankan aksi sesi.',
      },
      { status: 500 }
    );
  }
}
