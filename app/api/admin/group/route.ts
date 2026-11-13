import { NextResponse } from 'next/server';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  runTransaction,
  where,
  writeBatch,
} from 'firebase/firestore';
import { computePointsFromDeltas } from '@/lib/game-utils';
import { deriveGateToken, randomId, randomNonce } from '@/lib/server/crypto';
import { verifyAdminPinForSession } from '@/lib/server/admin-auth';
import { getGroupLogsOrdered, serverDb } from '@/lib/server/firestore-server';
import { GroupDoc } from '@/lib/types';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const sessionId = String(body?.sessionId ?? '').trim();
    const pin = String(body?.pin ?? '').trim();
    const action = String(body?.action ?? '').trim();
    const groupId = String(body?.groupId ?? '').trim();

    if (!sessionId || !pin || !action || !groupId) {
      return NextResponse.json(
        { error: 'Parameter kelompok tidak lengkap.' },
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
    const gateRef = doc(serverDb, 'sessions', sessionId, 'server_gate', 'main');
    const groupRef = doc(serverDb, 'sessions', sessionId, 'groups', groupId);
    const privRef = doc(serverDb, 'sessions', sessionId, 'group_private', groupId);

    if (action === 'rename') {
      const teamName = String(body?.teamName ?? '').trim();
      if (teamName.length < 1 || teamName.length > 50) {
        return NextResponse.json(
          { error: 'Nama kelompok harus 1 sampai 50 karakter.' },
          { status: 400 }
        );
      }

      const groupSnap = await getDoc(groupRef);
      if (!groupSnap.exists()) {
        return NextResponse.json(
          { error: 'Kelompok tidak ditemukan.' },
          { status: 404 }
        );
      }

      const batch = writeBatch(serverDb);
      batch.update(gateRef, {
        gateToken: deriveGateToken(sessionId),
        nonce: randomNonce(),
        updatedAtMs: now,
      });
      batch.update(groupRef, {
        teamName,
        updatedAtMs: now,
      });
      await batch.commit();
      return NextResponse.json({ ok: true });
    }

    if (action === 'delete') {
      const [reqSnap, logSnap] = await Promise.all([
        getDocs(
          query(
            collection(serverDb, 'sessions', sessionId, 'requests'),
            where('groupId', '==', groupId)
          )
        ),
        getDocs(
          query(
            collection(serverDb, 'sessions', sessionId, 'logs'),
            where('groupId', '==', groupId)
          )
        ),
      ]);

      const allRefs = [
        groupRef,
        privRef,
        ...reqSnap.docs.map((d) => d.ref),
        ...logSnap.docs.map((d) => d.ref),
      ];
      for (let i = 0; i < allRefs.length; i += 8) {
        const chunk = allRefs.slice(i, i + 8);
        const batch = writeBatch(serverDb);
        batch.update(gateRef, {
          gateToken: deriveGateToken(sessionId),
          nonce: randomNonce(),
          updatedAtMs: now,
        });
        for (const ref of chunk) {
          batch.delete(ref);
        }
        await batch.commit();
      }
      return NextResponse.json({ ok: true });
    }

    if (action === 'adjust_points') {
      const delta = Math.round(Number(body?.delta ?? 0));
      const reason = String(body?.reason ?? '').trim().slice(0, 200);

      if (!Number.isFinite(delta) || delta === 0 || Math.abs(delta) > 1000) {
        return NextResponse.json(
          { error: 'Perubahan poin harus antara -1000 sampai +1000 (tidak 0).' },
          { status: 400 }
        );
      }
      if (!reason) {
        return NextResponse.json(
          { error: 'Alasan penyesuaian poin wajib diisi.' },
          { status: 400 }
        );
      }

      const existingLogs = await getGroupLogsOrdered(sessionId, groupId);
      const basePoints = computePointsFromDeltas(existingLogs.map((l) => l.delta));

      await runTransaction(serverDb, async (tx) => {
        const groupSnap = await tx.get(groupRef);
        if (!groupSnap.exists()) {
          throw new Error('Kelompok tidak ditemukan.');
        }
        const group = groupSnap.data() as Omit<GroupDoc, 'id'>;
        const currentBalance = existingLogs.length > 0 ? basePoints : group.points;
        const newPoints = Math.max(0, currentBalance + delta);
        const logId = randomId('log');
        const sign = delta > 0 ? `+${delta}` : `${delta}`;

        tx.update(gateRef, {
          gateToken: deriveGateToken(sessionId),
          nonce: randomNonce(),
          updatedAtMs: now,
        });

        tx.update(groupRef, {
          points: newPoints,
          lastActivityText: `Admin: ${reason} (${sign} poin)`,
          lastActivityAtMs: now,
          updatedAtMs: now,
        });

        tx.set(doc(serverDb, 'sessions', sessionId, 'logs', logId), {
          groupId,
          teamName: group.teamName,
          action: delta > 0 ? 'Bonus manual admin' : 'Pengurangan manual admin',
          reason,
          delta,
          balanceAfter: newPoints,
          sheetNumber: 0,
          createdAtMs: now,
        });
      });

      return NextResponse.json({ ok: true });
    }

    return NextResponse.json(
      { error: 'Aksi kelompok tidak dikenali.' },
      { status: 400 }
    );
  } catch (error) {
    console.error('Admin group action error:', error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : 'Gagal memperbarui kelompok.',
      },
      { status: 500 }
    );
  }
}
