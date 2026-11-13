import { doc, getDoc } from 'firebase/firestore';
import { verifySecretHash } from './crypto';
import { serverDb } from './firestore-server';

export async function verifyAdminPinForSession(
  sessionId: string,
  pin: string
): Promise<boolean> {
  if (!sessionId || !pin) return false;
  const secretSnap = await getDoc(
    doc(serverDb, 'sessions', sessionId, 'secrets', 'config')
  );
  if (!secretSnap.exists()) return false;
  const expectedHash = String(secretSnap.data().adminPinHash || '');
  return verifySecretHash(pin.trim(), `admin:${sessionId}`, expectedHash);
}
