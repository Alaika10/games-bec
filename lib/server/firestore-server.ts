import { initializeApp, getApps } from 'firebase/app';
import {
  getFirestore,
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  where,
  writeBatch,
  Firestore,
} from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';
import {
  deriveGateToken,
  decryptJson,
  encryptJson,
  hashSecret,
  randomId,
  randomNonce,
} from './crypto';
import {
  computePointsFromDeltas,
  normalizeAnswerKey,
} from '../game-utils';
import {
  PointLogDoc,
  SessionDoc,
  SheetConfigItem,
} from '../types';

const SERVER_APP_NAME = 'hack-the-system-server';

function getServerApp() {
  const existing = getApps().find((a) => a.name === SERVER_APP_NAME);
  if (existing) return existing;
  return initializeApp(firebaseConfig, SERVER_APP_NAME);
}

export const serverDb: Firestore = getFirestore(
  getServerApp(),
  firebaseConfig.firestoreDatabaseId
);

export const DEFAULT_SEED_SHEETS: SheetConfigItem[] = [
  {
    sheetNumber: 1,
    sheetCode: 'RX-42',
    normalizedKey: normalizeAnswerKey('231'),
    hintText: 'Cari kalimat yang merangkum seluruh artikel.',
  },
  {
    sheetNumber: 2,
    sheetCode: 'KM-17',
    normalizedKey: normalizeAnswerKey('3-2019-12'),
    hintText: 'Cari angka dan tahun di dua paragraf pertama.',
  },
  {
    sheetNumber: 3,
    sheetCode: 'BT-83',
    normalizedKey: normalizeAnswerKey('21-4-305'),
    hintText: 'Lihat paragraf pertama dan kedua email.',
  },
  {
    sheetNumber: 4,
    sheetCode: 'ZQ-06',
    normalizedKey: normalizeAnswerKey('322'),
    hintText: 'Perhatikan apa yang tidak dilakukan oleh salah satu tokoh.',
  },
  {
    sheetNumber: 5,
    sheetCode: 'HV-59',
    normalizedKey: normalizeAnswerKey('LOCK'),
    hintText: 'Ambil huruf pertama dari jawaban nomor 2 sampai 5.',
  },
];

export const DEFAULT_SESSION_CODE = '4821';
export const DEFAULT_ADMIN_PIN = '2026';

export interface CreateSessionInput {
  sessionCode: string;
  title: string;
  adminPin: string;
  durationMinutes: number;
  maxGroups?: number;
  sheets?: SheetConfigItem[];
}

export async function createSessionRecord(input: CreateSessionInput): Promise<SessionDoc> {
  const now = Date.now();
  const sessionId = `ses_${input.sessionCode}_${now}`;
  const durationSeconds = Math.max(60, Math.min(86400, Math.round(input.durationMinutes * 60)));
  const maxGroups = Math.max(1, Math.min(50, Math.round(Number(input.maxGroups ?? 20))));

  const sessionData: Omit<SessionDoc, 'id'> = {
    sessionCode: input.sessionCode,
    title: input.title.trim().slice(0, 100) || 'HACK THE SYSTEM: Reading Escape Room',
    status: 'waiting',
    durationSeconds,
    remainingSecondsAtPause: durationSeconds,
    startedAtMs: 0,
    endedAtMs: 0,
    pointsCorrect: 10,
    pointsFastest: 5,
    pointsFinalFirst: 20,
    pointsWrong: -2,
    pointsHint: -3,
    pointsEmergency: -5,
    totalSheets: 5,
    maxGroups,
    lastEventId: '',
    lastEventType: 'none',
    lastEventTeam: '',
    lastEventMessage: '',
    lastEventAtMs: 0,
    createdAtMs: now,
    updatedAtMs: now,
  };

  const sheets = (input.sheets && input.sheets.length === 5 ? input.sheets : DEFAULT_SEED_SHEETS).map(
    (s, idx) => ({
      sheetNumber: idx + 1,
      sheetCode: s.sheetCode.trim().toUpperCase(),
      normalizedKey: normalizeAnswerKey(s.normalizedKey),
      hintText: s.hintText.trim(),
    })
  );

  const gateToken = deriveGateToken(sessionId);
  const batch = writeBatch(serverDb);

  batch.set(doc(serverDb, 'sessions', sessionId, 'server_gate', 'main'), {
    gateToken,
    nonce: randomNonce(),
    updatedAtMs: now,
  });

  batch.set(doc(serverDb, 'sessions', sessionId), sessionData);

  batch.set(doc(serverDb, 'sessions', sessionId, 'secrets', 'config'), {
    adminPinHash: hashSecret(input.adminPin.trim(), `admin:${sessionId}`),
    sheetsCipher: encryptJson(sheets),
    fastest1: '',
    fastest2: '',
    fastest3: '',
    fastest4: '',
    fastest5: '',
    updatedAtMs: now,
  });

  await batch.commit();

  return { id: sessionId, ...sessionData };
}

async function isSessionCompatible(sessionId: string): Promise<boolean> {
  try {
    const secSnap = await getDoc(
      doc(serverDb, 'sessions', sessionId, 'secrets', 'config')
    );
    if (!secSnap.exists()) return false;
    decryptJson<SheetConfigItem[]>(String(secSnap.data().sheetsCipher || ''));
    return true;
  } catch {
    return false;
  }
}

export async function findSessionByCode(sessionCode: string): Promise<SessionDoc | null> {
  const cleanCode = sessionCode.trim();
  if (!/^\d{4}$/.test(cleanCode)) return null;

  const q = query(
    collection(serverDb, 'sessions'),
    where('sessionCode', '==', cleanCode)
  );
  const snap = await getDocs(q);
  if (snap.empty) return null;

  const docs = snap.docs
    .filter((d) => !d.id.startsWith('_probe'))
    .map((d) => ({ id: d.id, ...(d.data() as Omit<SessionDoc, 'id'>) }))
    .sort((a, b) => b.createdAtMs - a.createdAtMs);

  for (const s of docs) {
    if (await isSessionCompatible(s.id)) {
      return s;
    }
  }
  return null;
}

export async function ensureDefaultSessionSeeded(): Promise<SessionDoc> {
  const snap = await getDocs(
    query(collection(serverDb, 'sessions'), where('sessionCode', '>=', '0000'))
  );
  const validSessions = snap.docs
    .filter((d) => !d.id.startsWith('_probe'))
    .map((d) => ({ id: d.id, ...(d.data() as Omit<SessionDoc, 'id'>) }))
    .sort((a, b) => b.createdAtMs - a.createdAtMs);

  for (const s of validSessions) {
    if (await isSessionCompatible(s.id)) {
      return s;
    }
  }

  return createSessionRecord({
    sessionCode: DEFAULT_SESSION_CODE,
    title: 'HACK THE SYSTEM: Reading Escape Room',
    adminPin: DEFAULT_ADMIN_PIN,
    durationMinutes: 85,
    sheets: DEFAULT_SEED_SHEETS,
  });
}

export async function getSessionById(sessionId: string): Promise<SessionDoc | null> {
  const snap = await getDoc(doc(serverDb, 'sessions', sessionId));
  if (!snap.exists()) return null;
  return { id: snap.id, ...(snap.data() as Omit<SessionDoc, 'id'>) };
}

export async function getGroupLogsOrdered(
  sessionId: string,
  groupId: string
): Promise<PointLogDoc[]> {
  const snap = await getDocs(
    query(collection(serverDb, 'sessions', sessionId, 'logs'), where('groupId', '==', groupId))
  );
  return snap.docs
    .map((d) => ({ id: d.id, ...(d.data() as Omit<PointLogDoc, 'id'>) }))
    .sort((a, b) => a.createdAtMs - b.createdAtMs);
}

export async function getGroupPointsFromLogs(
  sessionId: string,
  groupId: string
): Promise<number> {
  const logs = await getGroupLogsOrdered(sessionId, groupId);
  return computePointsFromDeltas(logs.map((l) => l.delta));
}

export function buildNewLogId(prefix = 'log'): string {
  return randomId(prefix);
}
