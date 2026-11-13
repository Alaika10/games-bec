import { NextResponse } from 'next/server';
import { collection, doc, getDocs, writeBatch } from 'firebase/firestore';
import {
  deriveGateToken,
  encryptJson,
  hashSecret,
  randomGroupCode,
  randomId,
  randomNonce,
} from '@/lib/server/crypto';
import {
  ensureDefaultSessionSeeded,
  findSessionByCode,
  serverDb,
} from '@/lib/server/firestore-server';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const sessionCode = String(body?.sessionCode ?? '').trim();
    const teamName = String(body?.teamName ?? '').trim();
    const rawMembers: unknown[] = Array.isArray(body?.members) ? body.members : [];
    const members = rawMembers
      .map((m) => String(m ?? '').trim().slice(0, 40))
      .filter((m) => m.length > 0);

    if (!/^\d{4}$/.test(sessionCode)) {
      return NextResponse.json(
        { error: 'Kode Sesi harus terdiri dari 4 digit angka.' },
        { status: 400 }
      );
    }
    if (teamName.length < 1 || teamName.length > 50) {
      return NextResponse.json(
        { error: 'Nama kelompok harus 1 sampai 50 karakter.' },
        { status: 400 }
      );
    }
    if (members.length < 2 || members.length > 5) {
      return NextResponse.json(
        { error: 'Masukkan 2 sampai 5 nama anggota kelompok.' },
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
    if (session.status === 'ended') {
      return NextResponse.json(
        { error: 'Sesi ini sudah berakhir. Hubungi admin untuk sesi baru.' },
        { status: 403 }
      );
    }

    const existingGroupsSnap = await getDocs(
      collection(serverDb, 'sessions', session.id, 'groups')
    );
    const duplicateName = existingGroupsSnap.docs.some(
      (d) =>
        String(d.data().teamName || '').toLowerCase() === teamName.toLowerCase()
    );
    if (duplicateName) {
      return NextResponse.json(
        { error: 'Nama kelompok sudah digunakan di sesi ini. Pilih nama lain.' },
        { status: 409 }
      );
    }

    const now = Date.now();
    const groupId = randomId('grp');
    const groupCode = randomGroupCode();
    const logId = randomId('log');

    const batch = writeBatch(serverDb);
    batch.update(doc(serverDb, 'sessions', session.id, 'server_gate', 'main'), {
      gateToken: deriveGateToken(session.id),
      nonce: randomNonce(),
      updatedAtMs: now,
    });

    batch.set(doc(serverDb, 'sessions', session.id, 'groups', groupId), {
      teamName,
      members,
      points: 0,
      currentSheet: 1,
      completedSheets: 0,
      finishedAtMs: 0,
      lastActivityText: 'Kelompok terdaftar dan siap bertanding',
      lastActivityAtMs: now,
      cooldownUntilMs: 0,
      lastSubmitAtMs: 0,
      createdAtMs: now,
      updatedAtMs: now,
    });

    batch.set(doc(serverDb, 'sessions', session.id, 'group_private', groupId), {
      groupCodeHash: hashSecret(groupCode, `group:${session.id}:${groupId}`),
      groupCodeCipher: encryptJson({ groupCode }),
      unlockedHintsCipher: encryptJson([]),
      unlockedEmergencyCipher: encryptJson([]),
      updatedAtMs: now,
    });

    batch.set(doc(serverDb, 'sessions', session.id, 'logs', logId), {
      groupId,
      teamName,
      action: 'Kelompok terdaftar',
      reason: `Anggota: ${members.join(', ')}`,
      delta: 0,
      balanceAfter: 0,
      sheetNumber: 0,
      createdAtMs: now,
    });

    await batch.commit();

    return NextResponse.json({
      sessionId: session.id,
      sessionCode: session.sessionCode,
      groupId,
      groupCode,
      teamName,
    });
  } catch (error) {
    console.error('Register group error:', error);
    return NextResponse.json(
      { error: 'Gagal mendaftarkan kelompok.' },
      { status: 500 }
    );
  }
}
