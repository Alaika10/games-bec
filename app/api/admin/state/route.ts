import { NextResponse } from 'next/server';
import { collection, doc, getDoc, getDocs } from 'firebase/firestore';
import { decryptJson } from '@/lib/server/crypto';
import { verifyAdminPinForSession } from '@/lib/server/admin-auth';
import { serverDb } from '@/lib/server/firestore-server';
import { computePointsFromDeltas, rankGroups } from '@/lib/game-utils';
import {
  AdminGroupSummary,
  GroupDoc,
  HelpRequestDoc,
  PointLogDoc,
  SessionDoc,
  SheetConfigItem,
} from '@/lib/types';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const sessionId = String(body?.sessionId ?? '').trim();
    const pin = String(body?.pin ?? '').trim();

    if (!sessionId || !pin) {
      return NextResponse.json(
        { error: 'Sesi atau PIN tidak lengkap.' },
        { status: 400 }
      );
    }

    const valid = await verifyAdminPinForSession(sessionId, pin);
    if (!valid) {
      return NextResponse.json(
        { error: 'PIN admin tidak valid.' },
        { status: 401 }
      );
    }

    const [sessionSnap, secretSnap, groupsSnap, reqSnap, logsSnap] =
      await Promise.all([
        getDoc(doc(serverDb, 'sessions', sessionId)),
        getDoc(doc(serverDb, 'sessions', sessionId, 'secrets', 'config')),
        getDocs(collection(serverDb, 'sessions', sessionId, 'groups')),
        getDocs(collection(serverDb, 'sessions', sessionId, 'requests')),
        getDocs(collection(serverDb, 'sessions', sessionId, 'logs')),
      ]);

    if (!sessionSnap.exists() || !secretSnap.exists()) {
      return NextResponse.json(
        { error: 'Sesi tidak ditemukan.' },
        { status: 404 }
      );
    }

    const privDocs = await Promise.all(
      groupsSnap.docs.map((g) =>
        getDoc(doc(serverDb, 'sessions', sessionId, 'group_private', g.id))
      )
    );

    const session: SessionDoc = {
      id: sessionSnap.id,
      ...(sessionSnap.data() as Omit<SessionDoc, 'id'>),
    };

    const sheets = decryptJson<SheetConfigItem[]>(
      String(secretSnap.data().sheetsCipher)
    );

    const privMap = new Map<string, string>();
    for (const pDoc of privDocs) {
      if (!pDoc.exists()) continue;
      try {
        const parsed = decryptJson<{ groupCode: string }>(
          String(pDoc.data().groupCodeCipher)
        );
        privMap.set(pDoc.id, parsed.groupCode);
      } catch {
        privMap.set(pDoc.id, '----');
      }
    }

    const logs: PointLogDoc[] = logsSnap.docs
      .map((d) => ({ id: d.id, ...(d.data() as Omit<PointLogDoc, 'id'>) }))
      .sort((a, b) => b.createdAtMs - a.createdAtMs);

    const logsByGroup = new Map<string, PointLogDoc[]>();
    for (const l of logs) {
      const arr = logsByGroup.get(l.groupId) || [];
      arr.push(l);
      logsByGroup.set(l.groupId, arr);
    }

    const rawGroups: AdminGroupSummary[] = groupsSnap.docs.map((d) => {
      const data = d.data() as Omit<GroupDoc, 'id'>;
      const gLogs = (logsByGroup.get(d.id) || []).slice().sort((a, b) => a.createdAtMs - b.createdAtMs);
      const computedPoints =
        gLogs.length > 0
          ? computePointsFromDeltas(gLogs.map((l) => l.delta))
          : data.points;
      return {
        id: d.id,
        ...data,
        points: computedPoints,
        groupCode: privMap.get(d.id) || '----',
      };
    });

    const groups = rankGroups(rawGroups);

    const requests: HelpRequestDoc[] = reqSnap.docs
      .map((d) => ({ id: d.id, ...(d.data() as Omit<HelpRequestDoc, 'id'>) }))
      .sort((a, b) => b.createdAtMs - a.createdAtMs);

    return NextResponse.json({
      session,
      sheets,
      groups,
      requests,
      logs,
      serverNowMs: Date.now(),
    });
  } catch (error) {
    console.error('Admin state error:', error);
    return NextResponse.json(
      { error: 'Gagal memuat data admin.' },
      { status: 500 }
    );
  }
}
