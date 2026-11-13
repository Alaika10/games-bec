'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { collection, doc, onSnapshot } from 'firebase/firestore';
import {
  Play,
  Pause,
  RotateCcw,
  Square,
  Plus,
  Download,
  Check,
  X,
  Pencil,
  Trash2,
  Sliders,
  Users,
  Bell,
  FileSpreadsheet,
  KeyRound,
  Lock,
  ExternalLink,
  Volume2,
  CheckCircle2,
  ShieldAlert,
} from 'lucide-react';
import { db, handleFirestoreError, OperationType, testFirestoreConnection } from '@/lib/firebase';
import {
  computeRemainingSeconds,
  formatClock,
  formatTimeWib,
  normalizeAnswerKey,
} from '@/lib/game-utils';
import {
  activateAudioEngine,
  isAudioUnlocked,
  playAdminCorrectSound,
  playAdminWrongSound,
} from '@/lib/sound';
import { AdminSessionPayload, PointLogDoc, SheetConfigItem } from '@/lib/types';
import { ProgressDots } from './ProgressDots';

const ADMIN_STORAGE_KEY = 'hts_admin_auth_v1';

interface AdminCreds {
  sessionId: string;
  pin: string;
}

interface SessionOption {
  id: string;
  sessionCode: string;
  title: string;
  status: string;
}

export function AdminDashboard() {
  const [creds, setCreds] = useState<AdminCreds | null>(null);
  const [sessionOptions, setSessionOptions] = useState<SessionOption[]>([]);
  const [loginCode, setLoginCode] = useState('');
  const [loginPin, setLoginPin] = useState('');
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginLoading, setLoginLoading] = useState(false);

  const [adminData, setAdminData] = useState<AdminSessionPayload | null>(null);
  const [serverOffsetMs, setServerOffsetMs] = useState(0);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [activeTab, setActiveTab] = useState<'groups' | 'requests' | 'config' | 'logs'>('groups');
  const [actionBusy, setActionBusy] = useState(false);
  const [statusNotice, setStatusNotice] = useState<{
    type: 'ok' | 'err';
    text: string;
  } | null>(null);
  const [audioReady, setAudioReady] = useState(() => isAudioUnlocked());
  const [liveAlert, setLiveAlert] = useState<{
    id: string;
    kind: 'correct' | 'wrong';
    title: string;
    detail: string;
  } | null>(null);

  const seenLogIdsRef = useRef<Set<string>>(new Set());
  const logsInitSessionRef = useRef<string>('');
  const alertTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Modals / Inline Forms
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newCode, setNewCode] = useState('');
  const [newTitle, setNewTitle] = useState('HACK THE SYSTEM: Reading Escape Room');
  const [newPinInput, setNewPinInput] = useState('');
  const [newDurationMin, setNewDurationMin] = useState(85);
  const [newMaxGroups, setNewMaxGroups] = useState(8);

  const [confirmAction, setConfirmAction] = useState<'end' | 'reset' | null>(null);
  const [confirmDeleteGroupId, setConfirmDeleteGroupId] = useState<string | null>(null);

  const [renameTarget, setRenameTarget] = useState<{ id: string; name: string } | null>(null);
  const [pointAdjustTarget, setPointAdjustTarget] = useState<{
    id: string;
    teamName: string;
  } | null>(null);
  const [adjustDelta, setAdjustDelta] = useState('5');
  const [adjustReason, setAdjustReason] = useState('');

  // Editable config form state
  const [draftTitle, setDraftTitle] = useState('');
  const [draftDurationMin, setDraftDurationMin] = useState(85);
  const [draftMaxGroups, setDraftMaxGroups] = useState(8);
  const [draftNewPin, setDraftNewPin] = useState('');
  const [draftPoints, setDraftPoints] = useState({
    pointsCorrect: 10,
    pointsFastest: 5,
    pointsFinalFirst: 20,
    pointsWrong: -2,
    pointsHint: -3,
    pointsEmergency: -5,
  });
  const [draftSheets, setDraftSheets] = useState<SheetConfigItem[]>([]);

  const loadSessionOptions = useCallback(async () => {
    try {
      const res = await fetch('/api/session/list');
      if (!res.ok) return;
      const data = await res.json();
      const list = (data.sessions || []) as SessionOption[];
      setSessionOptions(list);
      if (list.length > 0 && !loginCode) {
        setLoginCode(list[0].sessionCode);
      }
    } catch {
      // ignore
    }
  }, [loginCode]);

  useEffect(() => {
    testFirestoreConnection().catch(() => {});
    Promise.resolve().then(() => {
      loadSessionOptions();
      try {
        const raw = sessionStorage.getItem(ADMIN_STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw) as AdminCreds;
          if (parsed?.sessionId && parsed?.pin) {
            setCreds(parsed);
          }
        }
      } catch {
        sessionStorage.removeItem(ADMIN_STORAGE_KEY);
      }
    });
  }, [loadSessionOptions]);

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 500);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (audioReady) return;
    const unlockOnGesture = () => {
      activateAudioEngine()
        .then(() => setAudioReady(true))
        .catch(() => {});
    };
    window.addEventListener('pointerdown', unlockOnGesture, { once: true });
    window.addEventListener('keydown', unlockOnGesture, { once: true });
    return () => {
      window.removeEventListener('pointerdown', unlockOnGesture);
      window.removeEventListener('keydown', unlockOnGesture);
    };
  }, [audioReady]);

  const fetchAdminState = useCallback(
    async (c: AdminCreds, populateDrafts = false) => {
      try {
        const res = await fetch('/api/admin/state', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(c),
        });
        if (res.status === 401 || res.status === 404) {
          sessionStorage.removeItem(ADMIN_STORAGE_KEY);
          setCreds(null);
          setAdminData(null);
          setLoginError('Sesi atau PIN admin tidak valid.');
          return;
        }
        if (!res.ok) return;
        const payload = (await res.json()) as AdminSessionPayload;
        setServerOffsetMs(payload.serverNowMs - Date.now());
        setAdminData(payload);

        if (populateDrafts) {
          setDraftTitle(payload.session.title);
          setDraftDurationMin(Math.round(payload.session.durationSeconds / 60));
          setDraftMaxGroups(
            Math.min(8, Math.max(1, Number(payload.session.maxGroups ?? 8)))
          );
          setDraftPoints({
            pointsCorrect: payload.session.pointsCorrect,
            pointsFastest: payload.session.pointsFastest,
            pointsFinalFirst: payload.session.pointsFinalFirst,
            pointsWrong: payload.session.pointsWrong,
            pointsHint: payload.session.pointsHint,
            pointsEmergency: payload.session.pointsEmergency,
          });
          setDraftSheets(payload.sheets);
        }
      } catch {
        // ignore transient network error
      }
    },
    []
  );

  // Realtime triggers for admin state & sound notifications
  useEffect(() => {
    if (!creds) return;
    Promise.resolve().then(() => fetchAdminState(creds, true));

    const unsubSession = onSnapshot(
      doc(db, 'sessions', creds.sessionId),
      () => fetchAdminState(creds, false),
      (err) => handleFirestoreError(err, OperationType.GET, `sessions/${creds.sessionId}`)
    );
    const unsubGroups = onSnapshot(
      collection(db, 'sessions', creds.sessionId, 'groups'),
      () => fetchAdminState(creds, false),
      (err) =>
        handleFirestoreError(err, OperationType.LIST, `sessions/${creds.sessionId}/groups`)
    );
    const unsubReqs = onSnapshot(
      collection(db, 'sessions', creds.sessionId, 'requests'),
      () => fetchAdminState(creds, false),
      (err) =>
        handleFirestoreError(err, OperationType.LIST, `sessions/${creds.sessionId}/requests`)
    );
    const unsubLogs = onSnapshot(
      collection(db, 'sessions', creds.sessionId, 'logs'),
      (snap) => {
        if (logsInitSessionRef.current !== creds.sessionId) {
          seenLogIdsRef.current = new Set(snap.docs.map((d) => d.id));
          logsInitSessionRef.current = creds.sessionId;
        } else {
          const addedLogs = snap
            .docChanges()
            .filter(
              (ch) => ch.type === 'added' && !seenLogIdsRef.current.has(ch.doc.id)
            )
            .map((ch) => ({
              id: ch.doc.id,
              ...(ch.doc.data() as Omit<PointLogDoc, 'id'>),
            }))
            .sort((a, b) => a.createdAtMs - b.createdAtMs);

          for (const logItem of addedLogs) {
            seenLogIdsRef.current.add(logItem.id);
            const isVaultLog = logItem.action === 'Kata final benar';
            const isSheetCorrectLog =
              logItem.action.startsWith('Kunci Lembar ') &&
              logItem.action.endsWith(' benar');
            const isWrongLog = logItem.action.startsWith('Kode salah');

            if (isVaultLog || isSheetCorrectLog) {
              playAdminCorrectSound(logItem.teamName, isVaultLog);
              setLiveAlert({
                id: logItem.id,
                kind: 'correct',
                title: isVaultLog
                  ? `BRANKAS TERBUKA · ${logItem.teamName}`
                  : `KUNCI BENAR · ${logItem.teamName}`,
                detail: `${logItem.action} (+${logItem.delta} poin)`,
              });
              if (alertTimerRef.current) clearTimeout(alertTimerRef.current);
              alertTimerRef.current = setTimeout(() => setLiveAlert(null), 5500);
            } else if (isWrongLog) {
              playAdminWrongSound(logItem.teamName);
              setLiveAlert({
                id: logItem.id,
                kind: 'wrong',
                title: `KODE SALAH · ${logItem.teamName}`,
                detail: `${logItem.action} (${logItem.delta} poin)`,
              });
              if (alertTimerRef.current) clearTimeout(alertTimerRef.current);
              alertTimerRef.current = setTimeout(() => setLiveAlert(null), 5500);
            }
          }
        }
        fetchAdminState(creds, false);
      },
      (err) =>
        handleFirestoreError(err, OperationType.LIST, `sessions/${creds.sessionId}/logs`)
    );

    return () => {
      unsubSession();
      unsubGroups();
      unsubReqs();
      unsubLogs();
      if (alertTimerRef.current) {
        clearTimeout(alertTimerRef.current);
        alertTimerRef.current = null;
      }
    };
  }, [creds, fetchAdminState]);

  const handleActivateAdminAudio = async () => {
    await activateAudioEngine();
    setAudioReady(true);
  };

  const showToast = (type: 'ok' | 'err', text: string) => {
    setStatusNotice({ type, text });
    setTimeout(() => setStatusNotice(null), 4000);
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError(null);
    if (!audioReady) {
      activateAudioEngine()
        .then(() => setAudioReady(true))
        .catch(() => {});
    }
    setLoginLoading(true);
    try {
      const res = await fetch('/api/admin/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionCode: loginCode.trim(),
          pin: loginPin.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setLoginError(data.error || 'Autentikasi gagal.');
        return;
      }
      const nextCreds: AdminCreds = {
        sessionId: data.sessionId,
        pin: loginPin.trim(),
      };
      sessionStorage.setItem(ADMIN_STORAGE_KEY, JSON.stringify(nextCreds));
      setCreds(nextCreds);
    } catch {
      setLoginError('Gagal terhubung ke server.');
    } finally {
      setLoginLoading(false);
    }
  };

  const runSessionAction = async (
    action: string,
    payload?: Record<string, unknown>
  ) => {
    if (!creds) return;
    setActionBusy(true);
    try {
      const res = await fetch('/api/admin/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: creds.sessionId,
          pin: creds.pin,
          action,
          payload,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        showToast('err', data.error || 'Aksi sesi gagal.');
        return;
      }

      if (action === 'create' && data.newSessionId) {
        const switched: AdminCreds = {
          sessionId: data.newSessionId,
          pin: data.newPin,
        };
        sessionStorage.setItem(ADMIN_STORAGE_KEY, JSON.stringify(switched));
        setCreds(switched);
        setShowCreateModal(false);
        loadSessionOptions();
        showToast('ok', `Sesi baru ${data.newSessionCode} berhasil dibuat.`);
        return;
      }

      if (action === 'update_config' && payload?.newPin) {
        const updatedPin = String(payload.newPin).trim();
        if (updatedPin.length >= 4) {
          const updatedCreds = { ...creds, pin: updatedPin };
          sessionStorage.setItem(ADMIN_STORAGE_KEY, JSON.stringify(updatedCreds));
          setCreds(updatedCreds);
          setDraftNewPin('');
        }
      }

      setConfirmAction(null);
      await fetchAdminState(creds, action === 'update_config');
      showToast('ok', 'Perubahan sesi berhasil diterapkan.');
    } catch {
      showToast('err', 'Gagal terhubung ke server.');
    } finally {
      setActionBusy(false);
    }
  };

  const handleRequestDecision = async (
    requestId: string,
    decision: 'approve' | 'reject'
  ) => {
    if (!creds) return;
    setActionBusy(true);
    try {
      const res = await fetch('/api/admin/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: creds.sessionId,
          pin: creds.pin,
          requestId,
          decision,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        showToast('err', data.error || 'Gagal memproses permintaan.');
        return;
      }
      await fetchAdminState(creds);
      showToast(
        'ok',
        decision === 'approve' ? 'Permintaan disetujui.' : 'Permintaan ditolak.'
      );
    } catch {
      showToast('err', 'Gagal memproses permintaan.');
    } finally {
      setActionBusy(false);
    }
  };

  const handleGroupAction = async (body: Record<string, unknown>) => {
    if (!creds) return;
    setActionBusy(true);
    try {
      const res = await fetch('/api/admin/group', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: creds.sessionId,
          pin: creds.pin,
          ...body,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        showToast('err', data.error || 'Aksi kelompok gagal.');
        return;
      }
      setRenameTarget(null);
      setPointAdjustTarget(null);
      setConfirmDeleteGroupId(null);
      setAdjustReason('');
      await fetchAdminState(creds);
      showToast('ok', 'Data kelompok diperbarui.');
    } catch {
      showToast('err', 'Gagal terhubung ke server.');
    } finally {
      setActionBusy(false);
    }
  };

  const handleExportCsv = async (kind: 'results' | 'logs') => {
    if (!creds) return;
    try {
      const res = await fetch('/api/admin/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: creds.sessionId,
          pin: creds.pin,
          kind,
        }),
      });
      if (!res.ok) {
        showToast('err', 'Gagal mengekspor CSV.');
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download =
        kind === 'results'
          ? `hasil-escape-room-${adminData?.session.sessionCode || 'sesi'}.csv`
          : `log-aktivitas-${adminData?.session.sessionCode || 'sesi'}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      showToast('err', 'Gagal mengunduh CSV.');
    }
  };

  const pendingRequests = useMemo(
    () => (adminData?.requests || []).filter((r) => r.status === 'pending'),
    [adminData]
  );

  const remainingSec = adminData
    ? computeRemainingSeconds(adminData.session, nowMs + serverOffsetMs)
    : 0;

  if (!creds) {
    return (
      <div className="min-h-screen flex flex-col">
        <header className="border-b border-[#192A20] bg-[#060A08]">
          <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
            <span className="font-mono text-sm font-bold tracking-wider text-[#22FF88]">
              HACK THE SYSTEM · ADMIN
            </span>
            <div className="flex items-center gap-6 text-sm text-[#8AA899]">
              <Link href="/" className="hover:text-[#22FF88]">
                Halaman Kelompok
              </Link>
              <Link href="/layar" className="hover:text-[#22FF88]">
                Layar Proyektor
              </Link>
            </div>
          </div>
        </header>

        <main className="flex-1 flex items-center justify-center px-4 py-12">
          <div className="w-full max-w-md rounded-xl border border-[#1B2F23] bg-[#0B120E] p-6 sm:p-8 space-y-6">
            <div className="space-y-1.5">
              <div className="w-11 h-11 rounded-lg bg-[#102016] border border-[#22FF88]/30 flex items-center justify-center text-[#22FF88] mb-3">
                <Lock className="w-5 h-5" />
              </div>
              <h1 className="text-2xl font-bold text-[#E6F4EC]">
                Panel Kontrol Admin
              </h1>
              <p className="text-sm text-[#8AA899]">
                Masukkan Kode Sesi dan PIN Admin untuk mengelola permainan.
              </p>
            </div>

            {loginError && (
              <div className="p-3 rounded-lg border border-[#FF3B5C]/50 bg-[#FF3B5C]/10 text-sm text-[#FF9BAE]">
                {loginError}
              </div>
            )}

            <form onSubmit={handleLogin} className="space-y-4">
              <div className="space-y-1.5">
                <label
                  htmlFor="admin-session-code"
                  className="block font-mono text-xs tracking-wider text-[#8AA899]"
                >
                  KODE SESI (4 DIGIT)
                </label>
                <input
                  id="admin-session-code"
                  type="text"
                  inputMode="numeric"
                  maxLength={4}
                  value={loginCode}
                  onChange={(e) =>
                    setLoginCode(e.target.value.replace(/\D/g, '').slice(0, 4))
                  }
                  placeholder="4821"
                  className="w-full min-h-[48px] px-4 rounded-lg bg-[#050907] border border-[#243B2E] font-mono text-lg tracking-[0.2em] text-[#E6F4EC] focus:outline-none focus:border-[#22FF88]"
                  required
                />
                {sessionOptions.length > 0 && (
                  <p className="text-xs text-[#8AA899]">
                    Sesi tersedia:{' '}
                    {sessionOptions.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => setLoginCode(s.sessionCode)}
                        className="font-mono text-[#22FF88] underline mr-2 cursor-pointer"
                      >
                        {s.sessionCode}
                      </button>
                    ))}
                  </p>
                )}
              </div>

              <div className="space-y-1.5">
                <label
                  htmlFor="admin-pin"
                  className="block font-mono text-xs tracking-wider text-[#8AA899]"
                >
                  PIN ADMIN
                </label>
                <input
                  id="admin-pin"
                  type="password"
                  value={loginPin}
                  onChange={(e) => setLoginPin(e.target.value)}
                  placeholder="Masukkan PIN admin"
                  className="w-full min-h-[48px] px-4 rounded-lg bg-[#050907] border border-[#243B2E] font-mono text-lg text-[#E6F4EC] focus:outline-none focus:border-[#22FF88]"
                  required
                />
              </div>

              <button
                type="submit"
                disabled={loginLoading}
                className="w-full min-h-[48px] rounded-lg bg-[#22FF88] text-[#041209] font-bold text-base hover:bg-[#3EFF99] disabled:opacity-50 cursor-pointer"
              >
                {loginLoading ? 'Memverifikasi...' : 'Buka Panel Admin'}
              </button>
            </form>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col">
      {/* Admin Top Bar */}
      <header className="sticky top-0 z-30 border-b border-[#192A20] bg-[#060A08]/95 backdrop-blur-md">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-4">
          <div className="flex items-center gap-4 min-w-0">
            <span className="font-mono text-sm font-bold tracking-wider text-[#22FF88] whitespace-nowrap">
              ADMIN KONTROL
            </span>
            {adminData && (
              <span className="hidden sm:inline font-mono text-xs text-[#8AA899] truncate">
                Sesi {adminData.session.sessionCode} · {adminData.session.title}
              </span>
            )}
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={handleActivateAdminAudio}
              className={`min-h-[38px] px-3 rounded-lg border font-mono text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer ${
                audioReady
                  ? 'border-[#22FF88]/40 bg-[#0D1A12] text-[#22FF88] hover:bg-[#13261B]'
                  : 'border-[#FFB020]/60 bg-[#1F1708] text-[#FFD07A] hover:bg-[#2A1F0B]'
              }`}
            >
              <Volume2 className="w-3.5 h-3.5 shrink-0" />
              <span>{audioReady ? 'Suara Notifikasi Aktif' : 'Aktifkan Suara'}</span>
            </button>
            {adminData && (
              <Link
                href={`/layar?kode=${adminData.session.sessionCode}`}
                target="_blank"
                className="min-h-[38px] px-3 rounded-lg border border-[#243B2E] text-xs font-semibold text-[#E6F4EC] hover:border-[#22FF88]/50 inline-flex items-center gap-1.5 whitespace-nowrap"
              >
                <ExternalLink className="w-3.5 h-3.5 text-[#22FF88]" />
                <span>Buka Layar Proyektor</span>
              </Link>
            )}
            <button
              type="button"
              onClick={() => {
                sessionStorage.removeItem(ADMIN_STORAGE_KEY);
                setCreds(null);
                setAdminData(null);
              }}
              className="min-h-[38px] px-3 rounded-lg border border-[#243B2E] text-xs text-[#8AA899] hover:text-[#FF3B5C] whitespace-nowrap cursor-pointer"
            >
              Keluar PIN
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 w-full max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-6">
        {liveAlert && (
          <div
            role="status"
            className={`rounded-xl border p-4 flex items-center justify-between gap-4 ${
              liveAlert.kind === 'correct'
                ? 'border-[#22FF88] bg-[#0B2214] text-[#22FF88]'
                : 'border-[#FF3B5C] bg-[#240B10] text-[#FF9BAE]'
            }`}
          >
            <div className="flex items-center gap-3 min-w-0">
              {liveAlert.kind === 'correct' ? (
                <CheckCircle2 className="w-5 h-5 shrink-0 text-[#22FF88]" />
              ) : (
                <ShieldAlert className="w-5 h-5 shrink-0 text-[#FF3B5C]" />
              )}
              <div className="min-w-0">
                <p className="font-mono text-sm font-extrabold tracking-wide truncate">
                  {liveAlert.title}
                </p>
                <p className="text-xs text-[#E6F4EC] truncate">{liveAlert.detail}</p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setLiveAlert(null)}
              aria-label="Tutup notifikasi"
              className="min-h-[36px] min-w-[36px] rounded-lg text-[#8AA899] hover:text-[#E6F4EC] flex items-center justify-center shrink-0 cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {statusNotice && (
          <div
            role="status"
            className={`p-3.5 rounded-lg border text-sm font-medium ${
              statusNotice.type === 'ok'
                ? 'border-[#22FF88]/50 bg-[#22FF88]/10 text-[#22FF88]'
                : 'border-[#FF3B5C]/50 bg-[#FF3B5C]/10 text-[#FF9BAE]'
            }`}
          >
            {statusNotice.text}
          </div>
        )}

        {/* Session Lifecycle Control Bar */}
        {adminData && (
          <section className="rounded-xl border border-[#1B2F23] bg-[#0B120E] p-5 space-y-5">
            <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2.5 text-xs font-mono text-[#8AA899]">
                  <span>
                    KODE SESI:{' '}
                    <strong className="text-[#22FF88] text-sm">
                      {adminData.session.sessionCode}
                    </strong>
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>
                    STATUS:{' '}
                    <strong className="text-[#E6F4EC] uppercase">
                      {adminData.session.status === 'waiting'
                        ? 'Menunggu'
                        : adminData.session.status === 'running'
                          ? 'Berlangsung'
                          : adminData.session.status === 'paused'
                            ? 'Dijeda'
                            : 'Selesai'}
                    </strong>
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>
                    {adminData.groups.length} / {adminData.session.maxGroups ?? 8} Kelompok
                  </span>
                </div>
                <h1 className="text-xl sm:text-2xl font-bold text-[#E6F4EC]">
                  {adminData.session.title}
                </h1>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <div className="px-4 py-2 rounded-lg bg-[#050907] border border-[#243B2E] text-right">
                  <p className="font-mono text-[10px] text-[#8AA899]">TIMER SESI</p>
                  <p className="font-mono text-2xl font-bold text-[#22FF88] tabular-nums">
                    {formatClock(remainingSec)}
                  </p>
                </div>

                {adminData.session.status === 'waiting' && (
                  <button
                    type="button"
                    disabled={actionBusy}
                    onClick={() => runSessionAction('start')}
                    className="min-h-[44px] px-5 rounded-lg bg-[#22FF88] text-[#041209] font-bold text-sm inline-flex items-center gap-2 hover:bg-[#3EFF99] disabled:opacity-50 cursor-pointer"
                  >
                    <Play className="w-4 h-4" />
                    <span>MULAI</span>
                  </button>
                )}

                {adminData.session.status === 'running' && (
                  <button
                    type="button"
                    disabled={actionBusy}
                    onClick={() => runSessionAction('pause')}
                    className="min-h-[44px] px-5 rounded-lg bg-[#FFB020] text-[#1A1204] font-bold text-sm inline-flex items-center gap-2 hover:bg-[#FFC24E] disabled:opacity-50 cursor-pointer"
                  >
                    <Pause className="w-4 h-4" />
                    <span>JEDA</span>
                  </button>
                )}

                {adminData.session.status === 'paused' && (
                  <button
                    type="button"
                    disabled={actionBusy}
                    onClick={() => runSessionAction('resume')}
                    className="min-h-[44px] px-5 rounded-lg bg-[#22FF88] text-[#041209] font-bold text-sm inline-flex items-center gap-2 hover:bg-[#3EFF99] disabled:opacity-50 cursor-pointer"
                  >
                    <Play className="w-4 h-4" />
                    <span>LANJUT</span>
                  </button>
                )}

                {adminData.session.status !== 'ended' &&
                  adminData.session.status !== 'waiting' && (
                    <button
                      type="button"
                      disabled={actionBusy}
                      onClick={() => setConfirmAction('end')}
                      className="min-h-[44px] px-4 rounded-lg border border-[#FF3B5C]/60 bg-[#FF3B5C]/10 text-[#FF9BAE] font-semibold text-sm inline-flex items-center gap-2 hover:bg-[#FF3B5C]/20 cursor-pointer"
                    >
                      <Square className="w-4 h-4" />
                      <span>AKHIRI</span>
                    </button>
                  )}

                <button
                  type="button"
                  disabled={actionBusy}
                  onClick={() => setConfirmAction('reset')}
                  className="min-h-[44px] px-4 rounded-lg border border-[#243B2E] text-sm font-semibold text-[#E6F4EC] hover:border-[#FF3B5C]/50 inline-flex items-center gap-2 cursor-pointer"
                >
                  <RotateCcw className="w-4 h-4" />
                  <span>RESET</span>
                </button>

                <button
                  type="button"
                  onClick={() => setShowCreateModal(true)}
                  className="min-h-[44px] px-4 rounded-lg border border-[#22FF88]/40 text-sm font-semibold text-[#22FF88] hover:bg-[#102016] inline-flex items-center gap-2 cursor-pointer"
                >
                  <Plus className="w-4 h-4" />
                  <span>Buat Sesi Baru</span>
                </button>
              </div>
            </div>

            {confirmAction && (
              <div className="p-4 rounded-lg border border-[#FF3B5C]/60 bg-[#1B0B0F] flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <p className="text-sm text-[#FFCCD6]">
                  {confirmAction === 'end'
                    ? 'Yakin akhiri sesi sekarang? Proyektor akan menampilkan Podium 3 Besar dan kelompok tidak bisa mengirim kunci lagi.'
                    : 'Yakin RESET sesi ini? Semua kelompok, log aktivitas, dan permintaan di sesi ini akan dihapus.'}
                </p>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    disabled={actionBusy}
                    onClick={() => runSessionAction(confirmAction)}
                    className="min-h-[40px] px-4 rounded-lg bg-[#FF3B5C] text-white text-sm font-bold cursor-pointer"
                  >
                    Ya, {confirmAction === 'end' ? 'Akhiri' : 'Reset'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmAction(null)}
                    className="min-h-[40px] px-4 rounded-lg border border-[#243B2E] text-sm text-[#E6F4EC] cursor-pointer"
                  >
                    Batal
                  </button>
                </div>
              </div>
            )}
          </section>
        )}

        {/* Pending Queue Alert */}
        {pendingRequests.length > 0 && activeTab !== 'requests' && (
          <div className="rounded-xl border border-[#FFB020] bg-[#1F1708] p-4 flex items-center justify-between gap-4">
            <p className="text-sm font-semibold text-[#FFD07A]">
              Ada {pendingRequests.length} permintaan petunjuk/kunci darurat menunggu persetujuan.
            </p>
            <button
              type="button"
              onClick={() => setActiveTab('requests')}
              className="min-h-[40px] px-4 rounded-lg bg-[#FFB020] text-[#1A1204] font-bold text-xs whitespace-nowrap cursor-pointer"
            >
              Lihat Antrean
            </button>
          </div>
        )}

        {/* Navigation Tabs */}
        <div className="flex flex-wrap gap-2 p-1.5 rounded-xl bg-[#0B120E] border border-[#1B2F23]">
          <button
            type="button"
            onClick={() => setActiveTab('groups')}
            className={`min-h-[44px] px-4 rounded-lg text-sm font-semibold inline-flex items-center gap-2 transition-colors whitespace-nowrap cursor-pointer ${
              activeTab === 'groups'
                ? 'bg-[#22FF88] text-[#041209]'
                : 'text-[#8AA899] hover:text-[#E6F4EC]'
            }`}
          >
            <Users className="w-4 h-4" />
            <span>
              Kelompok ({adminData?.groups.length ?? 0}/{adminData?.session.maxGroups ?? 8})
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('requests')}
            className={`min-h-[44px] px-4 rounded-lg text-sm font-semibold inline-flex items-center gap-2 transition-colors whitespace-nowrap cursor-pointer ${
              activeTab === 'requests'
                ? 'bg-[#22FF88] text-[#041209]'
                : 'text-[#8AA899] hover:text-[#E6F4EC]'
            }`}
          >
            <Bell className="w-4 h-4" />
            <span>
              Antrean Permintaan
              {pendingRequests.length > 0 ? ` (${pendingRequests.length})` : ''}
            </span>
          </button>

          <button
            type="button"
            onClick={() => {
              setActiveTab('config');
              if (adminData) {
                setDraftTitle(adminData.session.title);
                setDraftDurationMin(Math.round(adminData.session.durationSeconds / 60));
                setDraftMaxGroups(
                  Math.min(8, Math.max(1, Number(adminData.session.maxGroups ?? 8)))
                );
                setDraftPoints({
                  pointsCorrect: adminData.session.pointsCorrect,
                  pointsFastest: adminData.session.pointsFastest,
                  pointsFinalFirst: adminData.session.pointsFinalFirst,
                  pointsWrong: adminData.session.pointsWrong,
                  pointsHint: adminData.session.pointsHint,
                  pointsEmergency: adminData.session.pointsEmergency,
                });
                setDraftSheets(adminData.sheets);
              }
            }}
            className={`min-h-[44px] px-4 rounded-lg text-sm font-semibold inline-flex items-center gap-2 transition-colors whitespace-nowrap cursor-pointer ${
              activeTab === 'config'
                ? 'bg-[#22FF88] text-[#041209]'
                : 'text-[#8AA899] hover:text-[#E6F4EC]'
            }`}
          >
            <Sliders className="w-4 h-4" />
            <span>Konten Lembar & Poin</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('logs')}
            className={`min-h-[44px] px-4 rounded-lg text-sm font-semibold inline-flex items-center gap-2 transition-colors whitespace-nowrap cursor-pointer ${
              activeTab === 'logs'
                ? 'bg-[#22FF88] text-[#041209]'
                : 'text-[#8AA899] hover:text-[#E6F4EC]'
            }`}
          >
            <FileSpreadsheet className="w-4 h-4" />
            <span>Log & Ekspor CSV</span>
          </button>
        </div>

        {/* TAB 1: GROUPS */}
        {activeTab === 'groups' && adminData && (
          <section className="rounded-xl border border-[#1B2F23] bg-[#0B120E] p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold text-[#E6F4EC]">
                Daftar Kelompok & Penyesuaian Poin
              </h2>
              <span className="font-mono text-xs text-[#8AA899]">
                Diurutkan berdasarkan peringkat
              </span>
            </div>

            {adminData.groups.length === 0 ? (
              <p className="py-8 text-center text-sm text-[#8AA899]">
                Belum ada kelompok terdaftar pada sesi ini. Bagikan Kode Sesi{' '}
                <strong className="font-mono text-[#22FF88]">
                  {adminData.session.sessionCode}
                </strong>{' '}
                kepada peserta.
              </p>
            ) : (
              <div className="space-y-3">
                {adminData.groups.map((g, idx) => (
                  <div
                    key={g.id}
                    className="rounded-lg border border-[#192B20] bg-[#060B08] p-4 flex flex-col lg:flex-row lg:items-center justify-between gap-4"
                  >
                    <div className="space-y-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-2.5">
                        <span className="font-mono text-sm font-bold text-[#22FF88]">
                          #{idx + 1}
                        </span>
                        <h3 className="text-base font-bold text-[#E6F4EC]">
                          {g.teamName}
                        </h3>
                        <span className="font-mono text-xs text-[#8AA899]">
                          · Kode Masuk: <strong className="text-[#E6F4EC]">{g.groupCode}</strong>
                        </span>
                      </div>
                      <p className="text-xs text-[#8AA899]">
                        Anggota: {g.members.join(', ')}
                      </p>
                      <p className="text-xs font-mono text-[#8AA899]">
                        Aktivitas terakhir: {g.lastActivityText} ({formatTimeWib(g.lastActivityAtMs)})
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-4 shrink-0">
                      <div className="space-y-1">
                        <ProgressDots
                          completed={g.completedSheets}
                          total={adminData.session.totalSheets}
                        />
                        <p className="font-mono text-[11px] text-[#8AA899]">
                          {g.completedSheets >= adminData.session.totalSheets
                            ? 'Selesai (5/5)'
                            : `Sedang di Lembar ${g.currentSheet}`}
                        </p>
                      </div>

                      <div className="text-right min-w-[80px]">
                        <p className="font-mono text-2xl font-extrabold text-[#22FF88] tabular-nums">
                          {g.points}
                        </p>
                        <p className="font-mono text-[10px] text-[#8AA899]">POIN</p>
                      </div>

                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            setPointAdjustTarget({ id: g.id, teamName: g.teamName });
                            setAdjustDelta('5');
                            setAdjustReason('');
                          }}
                          className="min-h-[40px] px-3 rounded-lg border border-[#22FF88]/40 text-xs font-semibold text-[#22FF88] hover:bg-[#102016] cursor-pointer"
                        >
                          +/- Poin
                        </button>
                        <button
                          type="button"
                          aria-label={`Ganti nama ${g.teamName}`}
                          onClick={() =>
                            setRenameTarget({ id: g.id, name: g.teamName })
                          }
                          className="min-h-[40px] min-w-[40px] rounded-lg border border-[#243B2E] text-[#8AA899] hover:text-[#E6F4EC] flex items-center justify-center cursor-pointer"
                        >
                          <Pencil className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          aria-label={`Hapus ${g.teamName}`}
                          onClick={() => setConfirmDeleteGroupId(g.id)}
                          className="min-h-[40px] min-w-[40px] rounded-lg border border-[#243B2E] text-[#8AA899] hover:text-[#FF3B5C] flex items-center justify-center cursor-pointer"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Inline Rename Modal */}
            {renameTarget && (
              <div className="p-4 rounded-lg border border-[#22FF88]/50 bg-[#0A1710] space-y-3">
                <p className="text-sm font-bold text-[#E6F4EC]">
                  Ganti Nama Kelompok
                </p>
                <div className="flex flex-col sm:flex-row gap-2">
                  <input
                    type="text"
                    maxLength={50}
                    value={renameTarget.name}
                    onChange={(e) =>
                      setRenameTarget({ ...renameTarget, name: e.target.value })
                    }
                    className="flex-1 min-h-[44px] px-3.5 rounded-lg bg-[#050907] border border-[#243B2E] text-sm text-[#E6F4EC]"
                  />
                  <button
                    type="button"
                    disabled={actionBusy}
                    onClick={() =>
                      handleGroupAction({
                        action: 'rename',
                        groupId: renameTarget.id,
                        teamName: renameTarget.name,
                      })
                    }
                    className="min-h-[44px] px-4 rounded-lg bg-[#22FF88] text-[#041209] font-bold text-sm cursor-pointer"
                  >
                    Simpan
                  </button>
                  <button
                    type="button"
                    onClick={() => setRenameTarget(null)}
                    className="min-h-[44px] px-4 rounded-lg border border-[#243B2E] text-sm text-[#E6F4EC] cursor-pointer"
                  >
                    Batal
                  </button>
                </div>
              </div>
            )}

            {/* Inline Manual Point Adjustment */}
            {pointAdjustTarget && (
              <div className="p-4 rounded-lg border border-[#22FF88]/50 bg-[#0A1710] space-y-3">
                <p className="text-sm font-bold text-[#E6F4EC]">
                  Tambah / Kurangi Poin Manual — {pointAdjustTarget.teamName}
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-12 gap-3">
                  <div className="sm:col-span-3">
                    <label className="block font-mono text-[11px] text-[#8AA899] mb-1">
                      DELTA POIN (mis. 5 atau -2)
                    </label>
                    <input
                      type="number"
                      value={adjustDelta}
                      onChange={(e) => setAdjustDelta(e.target.value)}
                      className="w-full min-h-[44px] px-3 rounded-lg bg-[#050907] border border-[#243B2E] font-mono text-sm text-[#E6F4EC]"
                    />
                  </div>
                  <div className="sm:col-span-6">
                    <label className="block font-mono text-[11px] text-[#8AA899] mb-1">
                      ALASAN (wajib dicatat di log)
                    </label>
                    <input
                      type="text"
                      maxLength={200}
                      value={adjustReason}
                      onChange={(e) => setAdjustReason(e.target.value)}
                      placeholder="Misal: Ringkasan satu kalimat / Tebakan warm-up"
                      className="w-full min-h-[44px] px-3 rounded-lg bg-[#050907] border border-[#243B2E] text-sm text-[#E6F4EC]"
                    />
                  </div>
                  <div className="sm:col-span-3 flex items-end gap-2">
                    <button
                      type="button"
                      disabled={actionBusy}
                      onClick={() =>
                        handleGroupAction({
                          action: 'adjust_points',
                          groupId: pointAdjustTarget.id,
                          delta: Number(adjustDelta),
                          reason: adjustReason,
                        })
                      }
                      className="flex-1 min-h-[44px] px-4 rounded-lg bg-[#22FF88] text-[#041209] font-bold text-sm cursor-pointer"
                    >
                      Terapkan
                    </button>
                    <button
                      type="button"
                      onClick={() => setPointAdjustTarget(null)}
                      className="min-h-[44px] px-3 rounded-lg border border-[#243B2E] text-sm text-[#E6F4EC] cursor-pointer"
                    >
                      Batal
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Inline Delete Confirmation */}
            {confirmDeleteGroupId && (
              <div className="p-4 rounded-lg border border-[#FF3B5C]/60 bg-[#1B0B0F] flex items-center justify-between gap-4">
                <p className="text-sm text-[#FFCCD6]">
                  Yakin hapus kelompok ini beserta seluruh log poinnya?
                </p>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={actionBusy}
                    onClick={() =>
                      handleGroupAction({
                        action: 'delete',
                        groupId: confirmDeleteGroupId,
                      })
                    }
                    className="min-h-[40px] px-4 rounded-lg bg-[#FF3B5C] text-white text-sm font-bold cursor-pointer"
                  >
                    Hapus
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDeleteGroupId(null)}
                    className="min-h-[40px] px-4 rounded-lg border border-[#243B2E] text-sm text-[#E6F4EC] cursor-pointer"
                  >
                    Batal
                  </button>
                </div>
              </div>
            )}
          </section>
        )}

        {/* TAB 2: REQUESTS QUEUE */}
        {activeTab === 'requests' && adminData && (
          <section className="rounded-xl border border-[#1B2F23] bg-[#0B120E] p-5 space-y-4">
            <h2 className="text-lg font-bold text-[#E6F4EC]">
              Antrean Permintaan Petunjuk & Kunci Darurat
            </h2>

            {adminData.requests.length === 0 ? (
              <p className="py-8 text-center text-sm text-[#8AA899]">
                Belum ada permintaan bantuan dari kelompok.
              </p>
            ) : (
              <div className="space-y-3">
                {adminData.requests.map((req) => (
                  <div
                    key={req.id}
                    className={`rounded-lg border p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4 ${
                      req.status === 'pending'
                        ? 'border-[#FFB020]/60 bg-[#171207]'
                        : 'border-[#192B20] bg-[#060B08]'
                    }`}
                  >
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2 font-mono text-xs">
                        <span
                          className={
                            req.type === 'emergency'
                              ? 'text-[#FF3B5C] font-bold'
                              : 'text-[#FFB020] font-bold'
                          }
                        >
                          {req.type === 'emergency' ? 'KUNCI DARURAT' : 'PETUNJUK'}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span className="text-[#8AA899]">
                          Lembar {req.sheetNumber}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span className="text-[#8AA899]">
                          {formatTimeWib(req.createdAtMs)}
                        </span>
                      </div>
                      <p className="text-base font-bold text-[#E6F4EC]">
                        {req.teamName}
                      </p>
                    </div>

                    {req.status === 'pending' ? (
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          type="button"
                          disabled={actionBusy}
                          onClick={() => handleRequestDecision(req.id, 'approve')}
                          className="min-h-[42px] px-4 rounded-lg bg-[#22FF88] text-[#041209] font-bold text-sm inline-flex items-center gap-1.5 cursor-pointer"
                        >
                          <Check className="w-4 h-4" />
                          <span>Setujui</span>
                        </button>
                        <button
                          type="button"
                          disabled={actionBusy}
                          onClick={() => handleRequestDecision(req.id, 'reject')}
                          className="min-h-[42px] px-4 rounded-lg border border-[#FF3B5C]/50 text-[#FF9BAE] font-semibold text-sm inline-flex items-center gap-1.5 cursor-pointer"
                        >
                          <X className="w-4 h-4" />
                          <span>Tolak</span>
                        </button>
                      </div>
                    ) : (
                      <span
                        className={`font-mono text-xs font-bold ${
                          req.status === 'approved'
                            ? 'text-[#22FF88]'
                            : 'text-[#FF3B5C]'
                        }`}
                      >
                        {req.status === 'approved' ? 'DISETUJUI' : 'DITOLAK'}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {/* TAB 3: SHEETS & POINTS CONFIG */}
        {activeTab === 'config' && adminData && (
          <section className="rounded-xl border border-[#1B2F23] bg-[#0B120E] p-5 space-y-6">
            <div className="space-y-1">
              <h2 className="text-lg font-bold text-[#E6F4EC]">
                Pengaturan Konten Lembar 1–5 & Aturan Poin
              </h2>
              <p className="text-sm text-[#8AA899]">
                Kunci jawaban otomatis disimpan dalam format ternormalisasi (huruf besar, tanpa spasi dan tanda strip).
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="space-y-1.5">
                <label className="block font-mono text-xs text-[#8AA899]">
                  JUDUL SESI
                </label>
                <input
                  type="text"
                  maxLength={100}
                  value={draftTitle}
                  onChange={(e) => setDraftTitle(e.target.value)}
                  className="w-full min-h-[44px] px-3.5 rounded-lg bg-[#050907] border border-[#243B2E] text-sm text-[#E6F4EC]"
                />
              </div>
              <div className="space-y-1.5">
                <label className="block font-mono text-xs text-[#8AA899]">
                  DURASI TIMER (MENIT)
                </label>
                <input
                  type="number"
                  min={1}
                  max={1440}
                  value={draftDurationMin}
                  onChange={(e) => setDraftDurationMin(Number(e.target.value))}
                  className="w-full min-h-[44px] px-3.5 rounded-lg bg-[#050907] border border-[#243B2E] font-mono text-sm text-[#E6F4EC]"
                />
              </div>
              <div className="space-y-1.5">
                <label className="block font-mono text-xs text-[#8AA899]">
                  MAKSIMAL KELOMPOK (1–8)
                </label>
                <input
                  type="number"
                  min={1}
                  max={8}
                  value={draftMaxGroups}
                  onChange={(e) =>
                    setDraftMaxGroups(
                      Math.min(8, Math.max(1, Number(e.target.value) || 1))
                    )
                  }
                  className="w-full min-h-[44px] px-3.5 rounded-lg bg-[#050907] border border-[#243B2E] font-mono text-sm text-[#E6F4EC]"
                />
              </div>
              <div className="space-y-1.5">
                <label className="block font-mono text-xs text-[#8AA899]">
                  GANTI PIN ADMIN (OPSIONAL)
                </label>
                <input
                  type="password"
                  value={draftNewPin}
                  onChange={(e) => setDraftNewPin(e.target.value)}
                  placeholder="Kosongkan jika tetap"
                  className="w-full min-h-[44px] px-3.5 rounded-lg bg-[#050907] border border-[#243B2E] font-mono text-sm text-[#E6F4EC]"
                />
              </div>
            </div>

            {/* Scoring Rules */}
            <div className="space-y-3">
              <h3 className="font-mono text-xs tracking-wider text-[#22FF88]">
                ATURAN POIN
              </h3>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                {[
                  { key: 'pointsCorrect', label: 'Kunci Benar' },
                  { key: 'pointsFastest', label: 'Tercepat (1-4)' },
                  { key: 'pointsFinalFirst', label: 'Final Pertama' },
                  { key: 'pointsWrong', label: 'Kode Salah' },
                  { key: 'pointsHint', label: 'Petunjuk' },
                  { key: 'pointsEmergency', label: 'Kunci Darurat' },
                ].map((item) => (
                  <div key={item.key} className="space-y-1">
                    <label className="block text-xs text-[#8AA899]">
                      {item.label}
                    </label>
                    <input
                      type="number"
                      value={draftPoints[item.key as keyof typeof draftPoints]}
                      onChange={(e) =>
                        setDraftPoints((prev) => ({
                          ...prev,
                          [item.key]: Number(e.target.value),
                        }))
                      }
                      className="w-full min-h-[42px] px-3 rounded-lg bg-[#050907] border border-[#243B2E] font-mono text-sm text-[#E6F4EC]"
                    />
                  </div>
                ))}
              </div>
            </div>

            {/* Sheets 1-5 */}
            <div className="space-y-3">
              <h3 className="font-mono text-xs tracking-wider text-[#22FF88]">
                KONTEN LEMBAR 1–5
              </h3>
              <div className="space-y-3">
                {draftSheets.map((sheet, idx) => (
                  <div
                    key={sheet.sheetNumber}
                    className="rounded-lg border border-[#192B20] bg-[#060B08] p-4 grid grid-cols-1 lg:grid-cols-12 gap-3"
                  >
                    <div className="lg:col-span-1 flex items-center">
                      <span className="font-mono text-sm font-bold text-[#22FF88]">
                        L{sheet.sheetNumber}
                      </span>
                    </div>
                    <div className="lg:col-span-2 space-y-1">
                      <label className="block font-mono text-[11px] text-[#8AA899]">
                        KODE LEMBAR
                      </label>
                      <input
                        type="text"
                        value={sheet.sheetCode}
                        onChange={(e) => {
                          const next = [...draftSheets];
                          next[idx] = { ...sheet, sheetCode: e.target.value.toUpperCase() };
                          setDraftSheets(next);
                        }}
                        className="w-full min-h-[42px] px-3 rounded-lg bg-[#0B120E] border border-[#243B2E] font-mono text-sm text-[#E6F4EC]"
                      />
                    </div>
                    <div className="lg:col-span-3 space-y-1">
                      <label className="block font-mono text-[11px] text-[#8AA899]">
                        KUNCI ({normalizeAnswerKey(sheet.normalizedKey)})
                      </label>
                      <input
                        type="text"
                        value={sheet.normalizedKey}
                        onChange={(e) => {
                          const next = [...draftSheets];
                          next[idx] = { ...sheet, normalizedKey: e.target.value };
                          setDraftSheets(next);
                        }}
                        className="w-full min-h-[42px] px-3 rounded-lg bg-[#0B120E] border border-[#243B2E] font-mono text-sm text-[#22FF88]"
                      />
                    </div>
                    <div className="lg:col-span-6 space-y-1">
                      <label className="block font-mono text-[11px] text-[#8AA899]">
                        TEKS PETUNJUK
                      </label>
                      <input
                        type="text"
                        value={sheet.hintText}
                        onChange={(e) => {
                          const next = [...draftSheets];
                          next[idx] = { ...sheet, hintText: e.target.value };
                          setDraftSheets(next);
                        }}
                        className="w-full min-h-[42px] px-3 rounded-lg bg-[#0B120E] border border-[#243B2E] text-sm text-[#E6F4EC]"
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex justify-end">
              <button
                type="button"
                disabled={actionBusy}
                onClick={() =>
                  runSessionAction('update_config', {
                    title: draftTitle,
                    durationMinutes: draftDurationMin,
                    maxGroups: draftMaxGroups,
                    newPin: draftNewPin,
                    ...draftPoints,
                    sheets: draftSheets,
                  })
                }
                className="min-h-[48px] px-6 rounded-lg bg-[#22FF88] text-[#041209] font-bold text-sm hover:bg-[#3EFF99] disabled:opacity-50 cursor-pointer"
              >
                Simpan Pengaturan Lembar & Poin
              </button>
            </div>
          </section>
        )}

        {/* TAB 4: LOGS & CSV EXPORT */}
        {activeTab === 'logs' && adminData && (
          <section className="rounded-xl border border-[#1B2F23] bg-[#0B120E] p-5 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-bold text-[#E6F4EC]">
                  Log Aktivitas & Ekspor CSV
                </h2>
                <p className="text-xs text-[#8AA899]">
                  Semua poin kelompok dihitung dari riwayat log ini.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2.5">
                <button
                  type="button"
                  onClick={() => handleExportCsv('results')}
                  className="min-h-[42px] px-4 rounded-lg bg-[#22FF88] text-[#041209] font-bold text-xs inline-flex items-center gap-2 cursor-pointer"
                >
                  <Download className="w-4 h-4" />
                  <span>Ekspor Hasil Akhir (CSV)</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleExportCsv('logs')}
                  className="min-h-[42px] px-4 rounded-lg border border-[#22FF88]/50 text-[#22FF88] font-bold text-xs inline-flex items-center gap-2 cursor-pointer"
                >
                  <Download className="w-4 h-4" />
                  <span>Ekspor Log Aktivitas (CSV)</span>
                </button>
              </div>
            </div>

            {adminData.logs.length === 0 ? (
              <p className="py-8 text-center text-sm text-[#8AA899]">
                Belum ada log aktivitas.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-[#1A2D22] font-mono text-xs text-[#8AA899]">
                      <th className="py-2.5 pr-4">WAKTU</th>
                      <th className="py-2.5 pr-4">KELOMPOK</th>
                      <th className="py-2.5 pr-4">AKSI</th>
                      <th className="py-2.5 pr-4">CATATAN</th>
                      <th className="py-2.5 pr-4 text-right">DELTA</th>
                      <th className="py-2.5 text-right">SALDO</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#15241B]">
                    {adminData.logs.map((log) => (
                      <tr key={log.id} className="hover:bg-[#101C15]">
                        <td className="py-2.5 pr-4 font-mono text-xs text-[#8AA899] whitespace-nowrap">
                          {formatTimeWib(log.createdAtMs)}
                        </td>
                        <td className="py-2.5 pr-4 font-semibold text-[#E6F4EC] whitespace-nowrap">
                          {log.teamName}
                        </td>
                        <td className="py-2.5 pr-4 text-[#E6F4EC]">{log.action}</td>
                        <td className="py-2.5 pr-4 text-xs text-[#8AA899]">
                          {log.reason}
                        </td>
                        <td
                          className={`py-2.5 pr-4 font-mono font-bold text-right tabular-nums ${
                            log.delta > 0
                              ? 'text-[#22FF88]'
                              : log.delta < 0
                                ? 'text-[#FF3B5C]'
                                : 'text-[#8AA899]'
                          }`}
                        >
                          {log.delta > 0 ? `+${log.delta}` : log.delta}
                        </td>
                        <td className="py-2.5 font-mono text-right text-[#E6F4EC] tabular-nums">
                          {log.balanceAfter}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}

        {/* Create New Session Modal */}
        {showCreateModal && (
          <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
            <div className="w-full max-w-md rounded-xl border border-[#22FF88]/50 bg-[#0B120E] p-6 space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-bold text-[#E6F4EC] inline-flex items-center gap-2">
                  <KeyRound className="w-5 h-5 text-[#22FF88]" />
                  <span>Buat Sesi Baru</span>
                </h2>
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="min-h-[36px] min-w-[36px] rounded-lg text-[#8AA899] hover:text-[#E6F4EC] flex items-center justify-center cursor-pointer"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="space-y-3">
                <div className="space-y-1">
                  <label className="block font-mono text-xs text-[#8AA899]">
                    KODE SESI BARU (4 DIGIT)
                  </label>
                  <input
                    type="text"
                    inputMode="numeric"
                    maxLength={4}
                    value={newCode}
                    onChange={(e) =>
                      setNewCode(e.target.value.replace(/\D/g, '').slice(0, 4))
                    }
                    placeholder="Contoh: 7390"
                    className="w-full min-h-[44px] px-3.5 rounded-lg bg-[#050907] border border-[#243B2E] font-mono text-base text-[#E6F4EC]"
                  />
                </div>
                <div className="space-y-1">
                  <label className="block font-mono text-xs text-[#8AA899]">
                    JUDUL SESI
                  </label>
                  <input
                    type="text"
                    maxLength={100}
                    value={newTitle}
                    onChange={(e) => setNewTitle(e.target.value)}
                    className="w-full min-h-[44px] px-3.5 rounded-lg bg-[#050907] border border-[#243B2E] text-sm text-[#E6F4EC]"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <label className="block font-mono text-xs text-[#8AA899]">
                      PIN ADMIN
                    </label>
                    <input
                      type="text"
                      value={newPinInput}
                      onChange={(e) => setNewPinInput(e.target.value)}
                      placeholder="Min. 4 karakter"
                      className="w-full min-h-[44px] px-3.5 rounded-lg bg-[#050907] border border-[#243B2E] font-mono text-sm text-[#E6F4EC]"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="block font-mono text-xs text-[#8AA899]">
                      DURASI (MENIT)
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={1440}
                      value={newDurationMin}
                      onChange={(e) => setNewDurationMin(Number(e.target.value))}
                      className="w-full min-h-[44px] px-3.5 rounded-lg bg-[#050907] border border-[#243B2E] font-mono text-sm text-[#E6F4EC]"
                    />
                  </div>
                </div>
                <div className="space-y-1">
                  <label className="block font-mono text-xs text-[#8AA899]">
                    MAKSIMAL KELOMPOK (1–8)
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={8}
                    value={newMaxGroups}
                    onChange={(e) =>
                      setNewMaxGroups(
                        Math.min(8, Math.max(1, Number(e.target.value) || 1))
                      )
                    }
                    className="w-full min-h-[44px] px-3.5 rounded-lg bg-[#050907] border border-[#243B2E] font-mono text-sm text-[#E6F4EC]"
                  />
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="min-h-[44px] px-4 rounded-lg border border-[#243B2E] text-sm text-[#E6F4EC] cursor-pointer"
                >
                  Batal
                </button>
                <button
                  type="button"
                  disabled={actionBusy}
                  onClick={() =>
                    runSessionAction('create', {
                      sessionCode: newCode,
                      title: newTitle,
                      adminPin: newPinInput || creds.pin,
                      durationMinutes: newDurationMin,
                      maxGroups: newMaxGroups,
                    })
                  }
                  className="min-h-[44px] px-5 rounded-lg bg-[#22FF88] text-[#041209] font-bold text-sm cursor-pointer"
                >
                  Buat Sesi
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
