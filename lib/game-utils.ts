import { GroupDoc, SessionDoc } from './types';

export function normalizeAnswerKey(input: string): string {
  return input.trim().toUpperCase().replace(/[\s-]+/g, '');
}

export function computeRemainingSeconds(
  session: Pick<SessionDoc, 'status' | 'remainingSecondsAtPause' | 'startedAtMs'>,
  nowMs: number
): number {
  if (session.status === 'ended') {
    return 0;
  }
  if (session.status !== 'running' || !session.startedAtMs) {
    return Math.max(0, session.remainingSecondsAtPause);
  }
  const elapsedSec = Math.max(0, Math.floor((nowMs - session.startedAtMs) / 1000));
  return Math.max(0, session.remainingSecondsAtPause - elapsedSec);
}

export function formatClock(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function formatTimeWib(ms: number): string {
  try {
    return new Intl.DateTimeFormat('id-ID', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toTimeString().slice(0, 8);
  }
}

export function rankGroups<T extends GroupDoc>(groups: T[]): T[] {
  return [...groups].sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    if (b.completedSheets !== a.completedSheets) return b.completedSheets - a.completedSheets;
    if (a.finishedAtMs > 0 && b.finishedAtMs > 0 && a.finishedAtMs !== b.finishedAtMs) {
      return a.finishedAtMs - b.finishedAtMs;
    }
    if (a.finishedAtMs > 0 && b.finishedAtMs === 0) return -1;
    if (b.finishedAtMs > 0 && a.finishedAtMs === 0) return 1;
    if (a.lastActivityAtMs !== b.lastActivityAtMs) return a.lastActivityAtMs - b.lastActivityAtMs;
    return a.createdAtMs - b.createdAtMs;
  });
}

export function computePointsFromDeltas(deltas: number[]): number {
  let total = 0;
  for (const delta of deltas) {
    total = Math.max(0, total + delta);
  }
  return total;
}
