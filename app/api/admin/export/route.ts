import { NextResponse } from 'next/server';
import { collection, doc, getDoc, getDocs } from 'firebase/firestore';
import { verifyAdminPinForSession } from '@/lib/server/admin-auth';
import { serverDb } from '@/lib/server/firestore-server';
import {
  computePointsFromDeltas,
  formatTimeWib,
  rankGroups,
} from '@/lib/game-utils';
import { GroupDoc, PointLogDoc, SessionDoc } from '@/lib/types';

function escapeCsv(value: unknown): string {
  const str = String(value ?? '');
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const sessionId = String(body?.sessionId ?? '').trim();
    const pin = String(body?.pin ?? '').trim();
    const kind = body?.kind === 'logs' ? 'logs' : 'results';

    if (!sessionId || !pin) {
      return NextResponse.json(
        { error: 'Sesi atau PIN tidak lengkap.' },
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

    const [sessionSnap, groupsSnap, logsSnap] = await Promise.all([
      getDoc(doc(serverDb, 'sessions', sessionId)),
      getDocs(collection(serverDb, 'sessions', sessionId, 'groups')),
      getDocs(collection(serverDb, 'sessions', sessionId, 'logs')),
    ]);

    if (!sessionSnap.exists()) {
      return NextResponse.json(
        { error: 'Sesi tidak ditemukan.' },
        { status: 404 }
      );
    }

    const session = sessionSnap.data() as Omit<SessionDoc, 'id'>;
    const logs: PointLogDoc[] = logsSnap.docs
      .map((d) => ({ id: d.id, ...(d.data() as Omit<PointLogDoc, 'id'>) }))
      .sort((a, b) => a.createdAtMs - b.createdAtMs);

    const logsByGroup = new Map<string, PointLogDoc[]>();
    for (const l of logs) {
      const list = logsByGroup.get(l.groupId) || [];
      list.push(l);
      logsByGroup.set(l.groupId, list);
    }

    const groups: GroupDoc[] = groupsSnap.docs.map((d) => {
      const data = d.data() as Omit<GroupDoc, 'id'>;
      const gLogs = logsByGroup.get(d.id) || [];
      const points =
        gLogs.length > 0
          ? computePointsFromDeltas(gLogs.map((l) => l.delta))
          : data.points;
      return { id: d.id, ...data, points };
    });

    const ranked = rankGroups(groups);

    let csvContent = '';
    let filename = '';

    if (kind === 'results') {
      const headers = [
        'Peringkat',
        'Nama Kelompok',
        'Anggota',
        'Poin Akhir',
        'Lembar Selesai',
        'Total Lembar',
        'Waktu Selesai',
        'Aktivitas Terakhir',
      ];
      const rows = ranked.map((g, idx) => [
        idx + 1,
        g.teamName,
        g.members.join('; '),
        g.points,
        g.completedSheets,
        session.totalSheets,
        g.finishedAtMs > 0 ? formatTimeWib(g.finishedAtMs) : 'Belum selesai',
        g.lastActivityText,
      ]);
      csvContent =
        '\uFEFF' +
        [headers, ...rows]
          .map((row) => row.map(escapeCsv).join(','))
          .join('\r\n');
      filename = `hasil-escape-room-${session.sessionCode}.csv`;
    } else {
      const headers = [
        'Waktu',
        'Kelompok',
        'Aksi',
        'Alasan',
        'Lembar',
        'Perubahan Poin',
        'Saldo Poin',
      ];
      const rows = logs.map((l) => [
        formatTimeWib(l.createdAtMs),
        l.teamName,
        l.action,
        l.reason,
        l.sheetNumber > 0 ? `Lembar ${l.sheetNumber}` : '-',
        l.delta,
        l.balanceAfter,
      ]);
      csvContent =
        '\uFEFF' +
        [headers, ...rows]
          .map((row) => row.map(escapeCsv).join(','))
          .join('\r\n');
      filename = `log-aktivitas-${session.sessionCode}.csv`;
    }

    return new NextResponse(csvContent, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (error) {
    console.error('Export CSV error:', error);
    return NextResponse.json(
      { error: 'Gagal mengekspor CSV.' },
      { status: 500 }
    );
  }
}
