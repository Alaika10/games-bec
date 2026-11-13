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
  Clock,
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
  playAdminTimeWarningSound,
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
    kind: 'correct' | 'wrong' | 'warning';
    title: string;
    detail: string;
  } | null>(null);

  const seenLogIdsRef = useRef<Set<string>>(new Set());
  const logsInitSessionRef = useRef<string>('');
  const alertTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firedTimeWarningsRef = useRef<Set<string>>(new Set());
  const prevRemainingRef = useRef<number | null>(null);

  // Modals / Inline Forms
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newCode, setNewCode] = useState('');
  const [newTitle, setNewTitle] = useState('HACK THE SYSTEM: Reading Escape Room');
  const [newPinInput, setNewPinInput] = useState('');
  const [newDurationMin, setNewDurationMin] = useState(85);
  const [newMaxGroups, setNewMaxGroups] = useState(20);

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
  const [draftMaxGroups, setDraftMaxGroups] = useState(20);
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
            Math.min(50, Math.max(1, Number(payload.session.maxGroups ?? 20)))
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

  const activeSessionId = adminData?.session.id ?? '';
  const activeSessionStatus = adminData?.session.status ?? 'waiting';
  const activeSessionStartedAt = adminData?.session.startedAtMs ?? 0;
  const activeSessionDuration = adminData?.session.durationSeconds ?? 0;

  useEffect(() => {
    if (!activeSessionId || activeSessionStatus !== 'running') {
      if (activeSessionStatus === 'waiting') {
        firedTimeWarningsRef.current.clear();
      }
      prevRemainingRef.current = null;
      return;
    }

    const prevRem = prevRemainingRef.current;
    prevRemainingRef.current = remainingSec;

    const triggerWarning = (
      stage: '5m' | '1m' | '30s' | '0s',
      title: string,
      detail: string
    ) => {
      const key = `${activeSessionId}:${activeSessionStartedAt}:${stage}`;
      if (firedTimeWarningsRef.current.has(key)) return;
      firedTimeWarningsRef.current.add(key);
      playAdminTimeWarningSound(stage);
      setLiveAlert({
        id: `time_${key}`,
        kind: 'warning',
        title,
        detail,
      });
      if (alertTimerRef.current) clearTimeout(alertTimerRef.current);
      alertTimerRef.current = setTimeout(() => setLiveAlert(null), 6500);
    };

    if (
      activeSessionDuration >= 360 &&
      remainingSec <= 300 &&
      remainingSec > 60 &&
      (prevRem === null || prevRem > 300)
    ) {
      triggerWarning(
        '5m',
        'PERINGATAN WAKTU · SISA 5 MENIT',
        'Sisa waktu sesi tinggal 5 menit lagi.'
      );
    } else if (
      activeSessionDuration >= 90 &&
      remainingSec <= 60 &&
      remainingSec > 30 &&
      (prevRem === null || prevRem > 60)
    ) {
      triggerWarning(
        '1m',
        'WAKTU HAMPIR HABIS · SISA 1 MENIT',
        'Sisa waktu sesi tinggal 1 menit lagi!'
      );
    } else if (
      activeSessionDuration >= 45 &&
      remainingSec <= 30 &&
      remainingSec > 0 &&
      (prevRem === null || prevRem > 30)
    ) {
      triggerWarning(
        '30s',
        'WAKTU HAMPIR HABIS · 30 DETIK TERAKHIR',
        'Sisa waktu sesi tinggal 30 detik lagi!'
      );
    } else if (remainingSec === 0 && prevRem !== null && prevRem > 0) {
      triggerWarning(
        '0s',
        'WAKTU SESI HABIS',
        'Waktu hitung mundur telah mencapai 00:00.'
      );
    }
  }, [
    activeSessionId,
    activeSessionStatus,
    activeSessionStartedAt,
    activeSessionDuration,
    remainingSec,
  ]);

  if (!creds) {
    return (
      <div className="min-h-screen flex flex-col">
        <header className="border-b border-[#1B2A21] bg-[#070A08]/92 backdrop-blur-md">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-4">
            <div className="flex items-center gap-3 min-w-0">
              <span className="font-mono text-sm font-bold tracking-wider text-[#22FF88] whitespace-nowrap shrink-0">
                HACK THE SYSTEM
              </span>
              <span className="text-xs text-[#8AA396] whitespace-nowrap shrink-0">
                Admin Kontrol
              </span>
            </div>
            <div className="flex items-center gap-5 text-sm text-[#8AA396] shrink-0">
              <Link href="/" className="hover:text-[#E8F3EC] transition-colors whitespace-nowrap shrink-0">
                Halaman Kelompok
              </Link>
              <Link href="/layar" className="hover:text-[#E8F3EC] transition-colors whitespace-nowrap shrink-0">
                Layar Proyektor
              </Link>
            </div>
          </div>
        </header>

        <main className="flex-1 flex items-center justify-center px-4 py-12">
          <div className="w-full max-w-md rounded-2xl border border-[#1B2A21] bg-[#0B110D] p-6 sm:p-8 space-y-6">
            <div className="space-y-2">
              <div className="w-11 h-11 rounded-xl bg-[#0E1E15] border border-[#22FF88]/30 flex items-center justify-center text-[#22FF88] mb-3">
                <Lock className="w-5 h-5" />
              </div>
              <h1 className="text-2xl font-bold text-[#E8F3EC]">
                Panel Kontrol Admin
              </h1>
              <p className="text-sm text-[#8AA396] leading-relaxed">
                Masukkan Kode Sesi dan PIN Admin untuk mengelola jalannya permainan.
              </p>
            </div>

            {loginError && (
              <div className="p-3.5 rounded-xl border border-[#FF3B5C]/45 bg-[#FF3B5C]/10 text-sm text-[#FF9BAE]">
                {loginError}
              </div>
            )}

            <form onSubmit={handleLogin} className="space-y-4">
              <div className="space-y-1.5">
                <label
                  htmlFor="admin-session-code"
                  className="block text-xs font-medium text-[#8AA396]"
                >
                  Kode Sesi (4 Digit)
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
                  className="w-full min-h-[48px] px-4 rounded-xl bg-[#060907] border border-[#1E3126] font-mono text-lg tracking-[0.2em] text-[#E8F3EC] focus:outline-none focus:border-[#22FF88]"
                  required
                />
                {sessionOptions.length > 0 && (
                  <p className="text-xs text-[#8AA396]">
                    Sesi tersedia:{' '}
                    {sessionOptions.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => setLoginCode(s.sessionCode)}
                        className="font-mono text-[#22FF88] underline underline-offset-2 mr-2.5 cursor-pointer"
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
                  className="block text-xs font-medium text-[#8AA396]"
                >
                  PIN Admin
                </label>
                <input
                  id="admin-pin"
                  type="password"
                  value={loginPin}
                  onChange={(e) => setLoginPin(e.target.value)}
                  placeholder="Masukkan PIN admin"
                  className="w-full min-h-[48px] px-4 rounded-xl bg-[#060907] border border-[#1E3126] font-mono text-lg text-[#E8F3EC] placeholder:text-sm placeholder:text-[#4C6557] focus:outline-none focus:border-[#22FF88]"
                  required
                />
              </div>

              <button
                type="submit"
                disabled={loginLoading}
                className="w-full min-h-[48px] rounded-xl bg-[#22FF88] text-[#041209] font-bold text-base hover:bg-[#3EFF99] disabled:opacity-50 cursor-pointer transition-colors"
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
      <header className="sticky top-0 z-30 border-b border-[#1B2A21] bg-[#070A08]/92 backdrop-blur-md">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <span className="font-mono text-sm font-bold tracking-wider text-[#22FF88] whitespace-nowrap shrink-0">
              ADMIN KONTROL
            </span>
            {adminData && (
              <span className="hidden sm:inline text-xs text-[#8AA396] truncate">
                Sesi <strong className="font-mono text-[#E8F3EC]">{adminData.session.sessionCode}</strong> · {adminData.session.title}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2.5 shrink-0">
            <button
              type="button"
              onClick={handleActivateAdminAudio}
              className={`min-h-[38px] px-3 rounded-lg border text-xs font-medium inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer transition-colors ${
                audioReady
                  ? 'border-[#22FF88]/40 bg-[#0D1E14] text-[#22FF88] hover:bg-[#12271B]'
                  : 'border-[#FFB020]/55 bg-[#1B1408] text-[#FFD07A] hover:bg-[#241B0B]'
              }`}
            >
              <Volume2 className="w-3.5 h-3.5 shrink-0" />
              <span>{audioReady ? 'Suara Notifikasi Aktif' : 'Aktifkan Suara'}</span>
            </button>
            {adminData && (
              <Link
                href={`/layar?kode=${adminData.session.sessionCode}`}
                target="_blank"
                className="min-h-[38px] px-3 rounded-lg border border-[#1E3126] text-xs font-medium text-[#E8F3EC] hover:border-[#22FF88]/45 inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors"
              >
                <ExternalLink className="w-3.5 h-3.5 text-[#22FF88] shrink-0" />
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
              className="min-h-[38px] px-3 rounded-lg border border-[#1E3126] text-xs font-medium text-[#8AA396] hover:text-[#FF3B5C] hover:border-[#FF3B5C]/40 whitespace-nowrap shrink-0 cursor-pointer transition-colors"
            >
              Keluar PIN
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 w-full max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-8 space-y-6">
        {liveAlert && (
          <div
            role="status"
            className={`relative overflow-hidden rounded-2xl border p-4 flex items-center justify-between gap-4 ${
              liveAlert.kind === 'correct'
                ? 'border-[#22FF88]/65 bg-[#0B1E13] text-[#22FF88]'
                : liveAlert.kind === 'warning'
                  ? 'border-[#FFB020]/65 bg-[#1B1408] text-[#FFD07A]'
                  : 'border-[#FF3B5C]/65 bg-[#1B0B0F] text-[#FF9BAE]'
            }`}
          >
            <div
              aria-hidden="true"
              className={`absolute inset-x-0 top-0 h-[2px] ${
                liveAlert.kind === 'correct'
                  ? 'bg-[#22FF88]'
                  : liveAlert.kind === 'warning'
                    ? 'bg-[#FFB020]'
                    : 'bg-[#FF3B5C]'
              }`}
            />
            <div className="flex items-center gap-3 min-w-0">
              {liveAlert.kind === 'correct' ? (
                <CheckCircle2 className="w-5 h-5 shrink-0 text-[#22FF88]" />
              ) : liveAlert.kind === 'warning' ? (
                <Clock className="w-5 h-5 shrink-0 text-[#FFB020]" />
              ) : (
                <ShieldAlert className="w-5 h-5 shrink-0 text-[#FF3B5C]" />
              )}
              <div className="min-w-0">
                <p className="font-mono text-sm font-bold tracking-wide truncate">
                  {liveAlert.title}
                </p>
                <p className="text-xs text-[#E8F3EC] truncate">{liveAlert.detail}</p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setLiveAlert(null)}
              aria-label="Tutup notifikasi"
              className="min-h-[36px] min-w-[36px] rounded-lg text-[#8AA396] hover:text-[#E8F3EC] flex items-center justify-center shrink-0 cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {statusNotice && (
          <div
            role="status"
            className={`p-3.5 rounded-xl border text-sm font-medium ${
              statusNotice.type === 'ok'
                ? 'border-[#22FF88]/45 bg-[#0B1E13] text-[#22FF88]'
                : 'border-[#FF3B5C]/45 bg-[#1B0B0F] text-[#FF9BAE]'
            }`}
          >
            {statusNotice.text}
          </div>
        )}

        {/* Session Lifecycle Control Bar */}
        {adminData && (
          <section className="rounded-2xl border border-[#1B2A21] bg-[#0B110D] p-5 sm:p-6 space-y-5">
            <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-5">
              <div className="space-y-1.5 min-w-0">
                <div className="flex flex-wrap items-center gap-2.5 text-xs text-[#8AA396]">
                  <span>
                    Kode Sesi{' '}
                    <strong className="font-mono text-[#22FF88] text-sm tabular-nums">
                      {adminData.session.sessionCode}
                    </strong>
                  </span>
                  <span aria-hidden="true" className="text-[#2D4437]">·</span>
                  <span>
                    Status:{' '}
                    <strong className="text-[#E8F3EC]">
                      {adminData.session.status === 'waiting'
                        ? 'Menunggu'
                        : adminData.session.status === 'running'
                          ? 'Berlangsung'
                          : adminData.session.status === 'paused'
                            ? 'Dijeda'
                            : 'Selesai'}
                    </strong>
                  </span>
                  <span aria-hidden="true" className="text-[#2D4437]">·</span>
                  <span className="font-mono tabular-nums">
                    {adminData.groups.length} / {adminData.session.maxGroups ?? 20} Kelompok
                  </span>
                </div>
                <h1 className="text-xl sm:text-2xl font-bold text-[#E8F3EC] truncate">
                  {adminData.session.title}
                </h1>
              </div>

              <div className="flex flex-wrap items-center gap-2.5 shrink-0">
                <div className="pr-4 mr-1 border-r border-[#17231C] text-left lg:text-right">
                  <p className="text-[11px] text-[#8AA396]">Timer Sesi</p>
                  <p className="font-mono text-2xl sm:text-3xl font-bold text-[#22FF88] tabular-nums leading-tight">
                    {formatClock(remainingSec)}
                  </p>
                </div>

                {adminData.session.status === 'waiting' && (
                  <button
                    type="button"
                    disabled={actionBusy}
                    onClick={() => runSessionAction('start')}
                    className="min-h-[44px] px-5 rounded-xl bg-[#22FF88] text-[#041209] font-bold text-sm inline-flex items-center gap-2 hover:bg-[#3EFF99] disabled:opacity-50 whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <Play className="w-4 h-4 shrink-0" />
                    <span>MULAI</span>
                  </button>
                )}

                {adminData.session.status === 'running' && (
                  <button
                    type="button"
                    disabled={actionBusy}
                    onClick={() => runSessionAction('pause')}
                    className="min-h-[44px] px-5 rounded-xl bg-[#FFB020] text-[#1A1204] font-bold text-sm inline-flex items-center gap-2 hover:bg-[#FFC24E] disabled:opacity-50 whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <Pause className="w-4 h-4 shrink-0" />
                    <span>JEDA</span>
                  </button>
                )}

                {adminData.session.status === 'paused' && (
                  <button
                    type="button"
                    disabled={actionBusy}
                    onClick={() => runSessionAction('resume')}
                    className="min-h-[44px] px-5 rounded-xl bg-[#22FF88] text-[#041209] font-bold text-sm inline-flex items-center gap-2 hover:bg-[#3EFF99] disabled:opacity-50 whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <Play className="w-4 h-4 shrink-0" />
                    <span>LANJUT</span>
                  </button>
                )}

                {adminData.session.status !== 'ended' &&
                  adminData.session.status !== 'waiting' && (
                    <button
                      type="button"
                      disabled={actionBusy}
                      onClick={() => setConfirmAction('end')}
                      className="min-h-[44px] px-4 rounded-xl border border-[#FF3B5C]/50 bg-[#1B0B0F] text-[#FF9BAE] font-semibold text-sm inline-flex items-center gap-2 hover:bg-[#271016] whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      <Square className="w-4 h-4 shrink-0" />
                      <span>AKHIRI</span>
                    </button>
                  )}

                <button
                  type="button"
                  disabled={actionBusy}
                  onClick={() => setConfirmAction('reset')}
                  className="min-h-[44px] px-4 rounded-xl border border-[#1E3126] text-sm font-medium text-[#E8F3EC] hover:border-[#FF3B5C]/50 hover:text-[#FF9BAE] inline-flex items-center gap-2 whitespace-nowrap shrink-0 cursor-pointer transition-colors"
                >
                  <RotateCcw className="w-4 h-4 shrink-0" />
                  <span>RESET</span>
                </button>

                <button
                  type="button"
                  onClick={() => setShowCreateModal(true)}
                  className="min-h-[44px] px-4 rounded-xl border border-[#22FF88]/40 text-sm font-medium text-[#22FF88] hover:bg-[#0E1E15] inline-flex items-center gap-2 whitespace-nowrap shrink-0 cursor-pointer transition-colors"
                >
                  <Plus className="w-4 h-4 shrink-0" />
                  <span>Buat Sesi Baru</span>
                </button>
              </div>
            </div>

            {confirmAction && (
              <div className="p-4 rounded-xl border border-[#FF3B5C]/50 bg-[#1B0B0F] flex flex-col sm:flex-row sm:items-center justify-between gap-3">
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
                    className="min-h-[40px] px-4 rounded-lg border border-[#1E3126] text-sm text-[#E8F3EC] cursor-pointer"
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
          <div className="rounded-2xl border border-[#FFB020]/60 bg-[#1B1408] p-4 flex items-center justify-between gap-4">
            <p className="text-sm font-semibold text-[#FFD07A]">
              Ada {pendingRequests.length} permintaan petunjuk/kunci darurat menunggu persetujuan.
            </p>
            <button
              type="button"
              onClick={() => setActiveTab('requests')}
              className="min-h-[40px] px-4 rounded-lg bg-[#FFB020] text-[#1A1204] font-bold text-xs whitespace-nowrap shrink-0 cursor-pointer"
            >
              Lihat Antrean
            </button>
          </div>
        )}

        {/* Navigation Tabs */}
        <div className="flex flex-wrap gap-1.5 p-1.5 rounded-2xl bg-[#0B110D] border border-[#1B2A21]">
          <button
            type="button"
            onClick={() => setActiveTab('groups')}
            className={`min-h-[42px] px-4 rounded-xl text-sm font-semibold inline-flex items-center gap-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              activeTab === 'groups'
                ? 'bg-[#22FF88] text-[#041209]'
                : 'text-[#8AA396] hover:text-[#E8F3EC]'
            }`}
          >
            <Users className="w-4 h-4 shrink-0" />
            <span className="tabular-nums">
              Kelompok ({adminData?.groups.length ?? 0}/{adminData?.session.maxGroups ?? 20})
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('requests')}
            className={`min-h-[42px] px-4 rounded-xl text-sm font-semibold inline-flex items-center gap-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              activeTab === 'requests'
                ? 'bg-[#22FF88] text-[#041209]'
                : 'text-[#8AA396] hover:text-[#E8F3EC]'
            }`}
          >
            <Bell className="w-4 h-4 shrink-0" />
            <span className="tabular-nums">
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
                  Math.min(50, Math.max(1, Number(adminData.session.maxGroups ?? 20)))
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
            className={`min-h-[42px] px-4 rounded-xl text-sm font-semibold inline-flex items-center gap-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              activeTab === 'config'
                ? 'bg-[#22FF88] text-[#041209]'
                : 'text-[#8AA396] hover:text-[#E8F3EC]'
            }`}
          >
            <Sliders className="w-4 h-4 shrink-0" />
            <span>Konten Lembar & Poin</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('logs')}
            className={`min-h-[42px] px-4 rounded-xl text-sm font-semibold inline-flex items-center gap-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              activeTab === 'logs'
                ? 'bg-[#22FF88] text-[#041209]'
                : 'text-[#8AA396] hover:text-[#E8F3EC]'
            }`}
          >
            <FileSpreadsheet className="w-4 h-4 shrink-0" />
            <span>Log & Ekspor CSV</span>
          </button>
        </div>

        {/* TAB 1: GROUPS */}
        {activeTab === 'groups' && adminData && (
          <section className="rounded-2xl border border-[#1B2A21] bg-[#0B110D] overflow-hidden">
            <div className="px-5 sm:px-6 py-4 border-b border-[#17231C] flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-lg font-bold text-[#E8F3EC]">
                Daftar Kelompok & Penyesuaian Poin
              </h2>
              <span className="text-xs text-[#8AA396]">
                Diurutkan berdasarkan peringkat
              </span>
            </div>

            {adminData.groups.length === 0 ? (
              <p className="px-6 py-12 text-center text-sm text-[#8AA396]">
                Belum ada kelompok terdaftar pada sesi ini. Bagikan Kode Sesi{' '}
                <strong className="font-mono text-[#22FF88] tabular-nums">
                  {adminData.session.sessionCode}
                </strong>{' '}
                kepada peserta.
              </p>
            ) : (
              <div className="divide-y divide-[#17231C]">
                {adminData.groups.map((g, idx) => (
                  <div
                    key={g.id}
                    className="px-5 sm:px-6 py-4 flex flex-col lg:flex-row lg:items-center justify-between gap-4 hover:bg-[#0E1611] transition-colors"
                  >
                    <div className="space-y-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-2.5">
                        <span className="font-mono text-sm font-bold text-[#22FF88] tabular-nums">
                          #{idx + 1}
                        </span>
                        <h3 className="text-base font-bold text-[#E8F3EC]">
                          {g.teamName}
                        </h3>
                        <span className="text-xs text-[#8AA396]">
                          · Kode Masuk{' '}
                          <strong className="font-mono text-[#E8F3EC]">{g.groupCode}</strong>
                        </span>
                      </div>
                      <p className="text-xs text-[#8AA396]">
                        Anggota: {g.members.join(', ')}
                      </p>
                      <p className="text-xs font-mono text-[#8AA396]">
                        Aktivitas terakhir: {g.lastActivityText} ({formatTimeWib(g.lastActivityAtMs)})
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-5 shrink-0">
                      <div className="space-y-1.5">
                        <ProgressDots
                          completed={g.completedSheets}
                          total={adminData.session.totalSheets}
                        />
                        <p className="font-mono text-[11px] text-[#8AA396] tabular-nums">
                          {g.completedSheets >= adminData.session.totalSheets
                            ? `Selesai (${adminData.session.totalSheets}/${adminData.session.totalSheets})`
                            : `Sedang di Lembar ${g.currentSheet}`}
                        </p>
                      </div>

                      <div className="text-right min-w-[76px]">
                        <p className="font-mono text-2xl font-bold text-[#22FF88] tabular-nums leading-none">
                          {g.points}
                        </p>
                        <p className="text-[11px] text-[#8AA396] mt-0.5">poin</p>
                      </div>

                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            setPointAdjustTarget({ id: g.id, teamName: g.teamName });
                            setAdjustDelta('5');
                            setAdjustReason('');
                          }}
                          className="min-h-[40px] px-3 rounded-lg border border-[#22FF88]/40 text-xs font-semibold text-[#22FF88] hover:bg-[#102016] whitespace-nowrap cursor-pointer transition-colors"
                        >
                          +/- Poin
                        </button>
                        <button
                          type="button"
                          aria-label={`Ganti nama ${g.teamName}`}
                          onClick={() =>
                            setRenameTarget({ id: g.id, name: g.teamName })
                          }
                          className="min-h-[40px] min-w-[40px] rounded-lg border border-[#1E3126] text-[#8AA396] hover:text-[#E8F3EC] flex items-center justify-center cursor-pointer transition-colors"
                        >
                          <Pencil className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          aria-label={`Hapus ${g.teamName}`}
                          onClick={() => setConfirmDeleteGroupId(g.id)}
                          className="min-h-[40px] min-w-[40px] rounded-lg border border-[#1E3126] text-[#8AA396] hover:text-[#FF3B5C] flex items-center justify-center cursor-pointer transition-colors"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Inline Rename Panel */}
            {renameTarget && (
              <div className="p-5 border-t border-[#22FF88]/40 bg-[#0A1710] space-y-3">
                <p className="text-sm font-bold text-[#E8F3EC]">
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
                    className="flex-1 min-h-[44px] px-3.5 rounded-xl bg-[#060907] border border-[#1E3126] text-sm text-[#E8F3EC] focus:outline-none focus:border-[#22FF88]"
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
                    className="min-h-[44px] px-4 rounded-xl bg-[#22FF88] text-[#041209] font-bold text-sm cursor-pointer"
                  >
                    Simpan
                  </button>
                  <button
                    type="button"
                    onClick={() => setRenameTarget(null)}
                    className="min-h-[44px] px-4 rounded-xl border border-[#1E3126] text-sm text-[#E8F3EC] cursor-pointer"
                  >
                    Batal
                  </button>
                </div>
              </div>
            )}

            {/* Inline Manual Point Adjustment */}
            {pointAdjustTarget && (
              <div className="p-5 border-t border-[#22FF88]/40 bg-[#0A1710] space-y-3">
                <p className="text-sm font-bold text-[#E8F3EC]">
                  Tambah / Kurangi Poin Manual — {pointAdjustTarget.teamName}
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-12 gap-3">
                  <div className="sm:col-span-3">
                    <label className="block text-xs font-medium text-[#8AA396] mb-1">
                      Delta Poin (mis. 5 atau -2)
                    </label>
                    <input
                      type="number"
                      value={adjustDelta}
                      onChange={(e) => setAdjustDelta(e.target.value)}
                      className="w-full min-h-[44px] px-3 rounded-xl bg-[#060907] border border-[#1E3126] font-mono text-sm text-[#E8F3EC] focus:outline-none focus:border-[#22FF88]"
                    />
                  </div>
                  <div className="sm:col-span-6">
                    <label className="block text-xs font-medium text-[#8AA396] mb-1">
                      Alasan (wajib dicatat di log)
                    </label>
                    <input
                      type="text"
                      maxLength={200}
                      value={adjustReason}
                      onChange={(e) => setAdjustReason(e.target.value)}
                      placeholder="Misal: Ringkasan satu kalimat / Tebakan warm-up"
                      className="w-full min-h-[44px] px-3 rounded-xl bg-[#060907] border border-[#1E3126] text-sm text-[#E8F3EC] focus:outline-none focus:border-[#22FF88]"
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
                      className="flex-1 min-h-[44px] px-4 rounded-xl bg-[#22FF88] text-[#041209] font-bold text-sm cursor-pointer"
                    >
                      Terapkan
                    </button>
                    <button
                      type="button"
                      onClick={() => setPointAdjustTarget(null)}
                      className="min-h-[44px] px-3 rounded-xl border border-[#1E3126] text-sm text-[#E8F3EC] cursor-pointer"
                    >
                      Batal
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Inline Delete Confirmation */}
            {confirmDeleteGroupId && (
              <div className="p-5 border-t border-[#FF3B5C]/45 bg-[#1B0B0F] flex items-center justify-between gap-4">
                <p className="text-sm text-[#FFCCD6]">
                  Yakin hapus kelompok ini beserta seluruh log poinnya?
                </p>
                <div className="flex items-center gap-2 shrink-0">
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
                    className="min-h-[40px] px-4 rounded-lg border border-[#1E3126] text-sm text-[#E8F3EC] cursor-pointer"
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
          <section className="rounded-2xl border border-[#1B2A21] bg-[#0B110D] overflow-hidden">
            <div className="px-5 sm:px-6 py-4 border-b border-[#17231C]">
              <h2 className="text-lg font-bold text-[#E8F3EC]">
                Antrean Permintaan Petunjuk & Kunci Darurat
              </h2>
            </div>

            {adminData.requests.length === 0 ? (
              <p className="px-6 py-12 text-center text-sm text-[#8AA396]">
                Belum ada permintaan bantuan dari kelompok.
              </p>
            ) : (
              <div className="divide-y divide-[#17231C]">
                {adminData.requests.map((req) => (
                  <div
                    key={req.id}
                    className={`px-5 sm:px-6 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4 ${
                      req.status === 'pending' ? 'bg-[#171207]' : ''
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
                          {req.type === 'emergency' ? 'Kunci Darurat' : 'Petunjuk'}
                        </span>
                        <span aria-hidden="true" className="text-[#2D4437]">·</span>
                        <span className="text-[#8AA396]">
                          Lembar {req.sheetNumber}
                        </span>
                        <span aria-hidden="true" className="text-[#2D4437]">·</span>
                        <span className="text-[#8AA396]">
                          {formatTimeWib(req.createdAtMs)}
                        </span>
                      </div>
                      <p className="text-base font-bold text-[#E8F3EC]">
                        {req.teamName}
                      </p>
                    </div>

                    {req.status === 'pending' ? (
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          type="button"
                          disabled={actionBusy}
                          onClick={() => handleRequestDecision(req.id, 'approve')}
                          className="min-h-[42px] px-4 rounded-xl bg-[#22FF88] text-[#041209] font-bold text-sm inline-flex items-center gap-1.5 cursor-pointer"
                        >
                          <Check className="w-4 h-4" />
                          <span>Setujui</span>
                        </button>
                        <button
                          type="button"
                          disabled={actionBusy}
                          onClick={() => handleRequestDecision(req.id, 'reject')}
                          className="min-h-[42px] px-4 rounded-xl border border-[#FF3B5C]/45 text-[#FF9BAE] font-semibold text-sm inline-flex items-center gap-1.5 cursor-pointer"
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
                        {req.status === 'approved' ? 'Disetujui' : 'Ditolak'}
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
          <section className="rounded-2xl border border-[#1B2A21] bg-[#0B110D] p-5 sm:p-6 space-y-7">
            <div className="space-y-1 pb-4 border-b border-[#17231C]">
              <h2 className="text-lg font-bold text-[#E8F3EC]">
                Pengaturan Konten Lembar 1–5 & Aturan Poin
              </h2>
              <p className="text-sm text-[#8AA396]">
                Kunci jawaban otomatis disimpan dalam format ternormalisasi (huruf besar, tanpa spasi dan tanda strip).
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-[#8AA396]">
                  Judul Sesi
                </label>
                <input
                  type="text"
                  maxLength={100}
                  value={draftTitle}
                  onChange={(e) => setDraftTitle(e.target.value)}
                  className="w-full min-h-[44px] px-3.5 rounded-xl bg-[#060907] border border-[#1E3126] text-sm text-[#E8F3EC] focus:outline-none focus:border-[#22FF88]"
                />
              </div>
              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-[#8AA396]">
                  Durasi Timer (Menit)
                </label>
                <input
                  type="number"
                  min={1}
                  max={1440}
                  value={draftDurationMin}
                  onChange={(e) => setDraftDurationMin(Number(e.target.value))}
                  className="w-full min-h-[44px] px-3.5 rounded-xl bg-[#060907] border border-[#1E3126] font-mono text-sm text-[#E8F3EC] focus:outline-none focus:border-[#22FF88]"
                />
              </div>
              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-[#8AA396]">
                  Maksimal Kelompok (1–50)
                </label>
                <input
                  type="number"
                  min={1}
                  max={50}
                  value={draftMaxGroups}
                  onChange={(e) =>
                    setDraftMaxGroups(
                      Math.min(50, Math.max(1, Number(e.target.value) || 1))
                    )
                  }
                  className="w-full min-h-[44px] px-3.5 rounded-xl bg-[#060907] border border-[#1E3126] font-mono text-sm text-[#E8F3EC] focus:outline-none focus:border-[#22FF88]"
                />
              </div>
              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-[#8AA396]">
                  Ganti PIN Admin (Opsional)
                </label>
                <input
                  type="password"
                  value={draftNewPin}
                  onChange={(e) => setDraftNewPin(e.target.value)}
                  placeholder="Kosongkan jika tetap"
                  className="w-full min-h-[44px] px-3.5 rounded-xl bg-[#060907] border border-[#1E3126] font-mono text-sm text-[#E8F3EC] placeholder:text-[#4C6557] focus:outline-none focus:border-[#22FF88]"
                />
              </div>
            </div>

            {/* Scoring Rules */}
            <div className="space-y-3 pt-2 border-t border-[#17231C]">
              <h3 className="text-sm font-semibold text-[#22FF88]">
                Aturan Poin
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
                    <label className="block text-xs text-[#8AA396]">
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
                      className="w-full min-h-[42px] px-3 rounded-xl bg-[#060907] border border-[#1E3126] font-mono text-sm text-[#E8F3EC] focus:outline-none focus:border-[#22FF88]"
                    />
                  </div>
                ))}
              </div>
            </div>

            {/* Sheets 1-5 — Hairline-divided rows inside unified surface */}
            <div className="space-y-3 pt-2 border-t border-[#17231C]">
              <h3 className="text-sm font-semibold text-[#22FF88]">
                Konten Lembar 1–5
              </h3>
              <div className="divide-y divide-[#17231C] border-y border-[#17231C]">
                {draftSheets.map((sheet, idx) => (
                  <div
                    key={sheet.sheetNumber}
                    className="py-4 grid grid-cols-1 lg:grid-cols-12 gap-3 items-end"
                  >
                    <div className="lg:col-span-1 flex items-center lg:pb-2.5">
                      <span className="font-mono text-sm font-bold text-[#22FF88] tabular-nums">
                        L{sheet.sheetNumber}
                      </span>
                    </div>
                    <div className="lg:col-span-2 space-y-1">
                      <label className="block text-xs text-[#8AA396]">
                        Kode Lembar
                      </label>
                      <input
                        type="text"
                        value={sheet.sheetCode}
                        onChange={(e) => {
                          const next = [...draftSheets];
                          next[idx] = { ...sheet, sheetCode: e.target.value.toUpperCase() };
                          setDraftSheets(next);
                        }}
                        className="w-full min-h-[42px] px-3 rounded-xl bg-[#060907] border border-[#1E3126] font-mono text-sm text-[#E8F3EC] focus:outline-none focus:border-[#22FF88]"
                      />
                    </div>
                    <div className="lg:col-span-3 space-y-1">
                      <label className="block text-xs text-[#8AA396]">
                        Kunci ({normalizeAnswerKey(sheet.normalizedKey)})
                      </label>
                      <input
                        type="text"
                        value={sheet.normalizedKey}
                        onChange={(e) => {
                          const next = [...draftSheets];
                          next[idx] = { ...sheet, normalizedKey: e.target.value };
                          setDraftSheets(next);
                        }}
                        className="w-full min-h-[42px] px-3 rounded-xl bg-[#060907] border border-[#1E3126] font-mono text-sm text-[#22FF88] focus:outline-none focus:border-[#22FF88]"
                      />
                    </div>
                    <div className="lg:col-span-6 space-y-1">
                      <label className="block text-xs text-[#8AA396]">
                        Teks Petunjuk
                      </label>
                      <input
                        type="text"
                        value={sheet.hintText}
                        onChange={(e) => {
                          const next = [...draftSheets];
                          next[idx] = { ...sheet, hintText: e.target.value };
                          setDraftSheets(next);
                        }}
                        className="w-full min-h-[42px] px-3 rounded-xl bg-[#060907] border border-[#1E3126] text-sm text-[#E8F3EC] focus:outline-none focus:border-[#22FF88]"
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
                className="min-h-[48px] px-6 rounded-xl bg-[#22FF88] text-[#041209] font-bold text-sm hover:bg-[#3EFF99] disabled:opacity-50 cursor-pointer transition-colors"
              >
                Simpan Pengaturan Lembar & Poin
              </button>
            </div>
          </section>
        )}

        {/* TAB 4: LOGS & CSV EXPORT */}
        {activeTab === 'logs' && adminData && (
          <section className="rounded-2xl border border-[#1B2A21] bg-[#0B110D] overflow-hidden">
            <div className="px-5 sm:px-6 py-4 border-b border-[#17231C] flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-bold text-[#E8F3EC]">
                  Log Aktivitas & Ekspor CSV
                </h2>
                <p className="text-xs text-[#8AA396]">
                  Semua poin kelompok dihitung dari riwayat log ini.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2.5 shrink-0">
                <button
                  type="button"
                  onClick={() => handleExportCsv('results')}
                  className="min-h-[40px] px-4 rounded-xl bg-[#22FF88] text-[#041209] font-bold text-xs inline-flex items-center gap-2 whitespace-nowrap cursor-pointer"
                >
                  <Download className="w-4 h-4" />
                  <span>Ekspor Hasil Akhir (CSV)</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleExportCsv('logs')}
                  className="min-h-[40px] px-4 rounded-xl border border-[#22FF88]/45 text-[#22FF88] font-bold text-xs inline-flex items-center gap-2 whitespace-nowrap cursor-pointer"
                >
                  <Download className="w-4 h-4" />
                  <span>Ekspor Log Aktivitas (CSV)</span>
                </button>
              </div>
            </div>

            {adminData.logs.length === 0 ? (
              <p className="px-6 py-12 text-center text-sm text-[#8AA396]">
                Belum ada log aktivitas.
              </p>
            ) : (
              <div className="overflow-x-auto px-5 sm:px-6 py-2">
                <table className="w-full text-left border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-[#17231C] text-xs font-medium text-[#8AA396]">
                      <th className="py-3 pr-4">Waktu</th>
                      <th className="py-3 pr-4">Kelompok</th>
                      <th className="py-3 pr-4">Aksi</th>
                      <th className="py-3 pr-4">Catatan</th>
                      <th className="py-3 pr-4 text-right">Delta</th>
                      <th className="py-3 text-right">Saldo</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#17231C]">
                    {adminData.logs.map((log) => (
                      <tr key={log.id} className="hover:bg-[#0E1611] transition-colors">
                        <td className="py-3 pr-4 font-mono text-xs text-[#8AA396] whitespace-nowrap tabular-nums">
                          {formatTimeWib(log.createdAtMs)}
                        </td>
                        <td className="py-3 pr-4 font-semibold text-[#E8F3EC] whitespace-nowrap">
                          {log.teamName}
                        </td>
                        <td className="py-3 pr-4 text-[#E8F3EC]">{log.action}</td>
                        <td className="py-3 pr-4 text-xs text-[#8AA396]">
                          {log.reason}
                        </td>
                        <td
                          className={`py-3 pr-4 font-mono font-bold text-right tabular-nums ${
                            log.delta > 0
                              ? 'text-[#22FF88]'
                              : log.delta < 0
                                ? 'text-[#FF3B5C]'
                                : 'text-[#8AA396]'
                          }`}
                        >
                          {log.delta > 0 ? `+${log.delta}` : log.delta}
                        </td>
                        <td className="py-3 font-mono text-right text-[#E8F3EC] tabular-nums">
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
            <div className="w-full max-w-md rounded-2xl border border-[#22FF88]/45 bg-[#0B110D] p-6 space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-bold text-[#E8F3EC] inline-flex items-center gap-2">
                  <KeyRound className="w-5 h-5 text-[#22FF88]" />
                  <span>Buat Sesi Baru</span>
                </h2>
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="min-h-[36px] min-w-[36px] rounded-lg text-[#8AA396] hover:text-[#E8F3EC] flex items-center justify-center cursor-pointer"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="space-y-3">
                <div className="space-y-1">
                  <label className="block text-xs font-medium text-[#8AA396]">
                    Kode Sesi Baru (4 Digit)
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
                    className="w-full min-h-[44px] px-3.5 rounded-xl bg-[#060907] border border-[#1E3126] font-mono text-base text-[#E8F3EC] focus:outline-none focus:border-[#22FF88]"
                  />
                </div>
                <div className="space-y-1">
                  <label className="block text-xs font-medium text-[#8AA396]">
                    Judul Sesi
                  </label>
                  <input
                    type="text"
                    maxLength={100}
                    value={newTitle}
                    onChange={(e) => setNewTitle(e.target.value)}
                    className="w-full min-h-[44px] px-3.5 rounded-xl bg-[#060907] border border-[#1E3126] text-sm text-[#E8F3EC] focus:outline-none focus:border-[#22FF88]"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <label className="block text-xs font-medium text-[#8AA396]">
                      PIN Admin
                    </label>
                    <input
                      type="text"
                      value={newPinInput}
                      onChange={(e) => setNewPinInput(e.target.value)}
                      placeholder="Min. 4 karakter"
                      className="w-full min-h-[44px] px-3.5 rounded-xl bg-[#060907] border border-[#1E3126] font-mono text-sm text-[#E8F3EC] focus:outline-none focus:border-[#22FF88]"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="block text-xs font-medium text-[#8AA396]">
                      Durasi (Menit)
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={1440}
                      value={newDurationMin}
                      onChange={(e) => setNewDurationMin(Number(e.target.value))}
                      className="w-full min-h-[44px] px-3.5 rounded-xl bg-[#060907] border border-[#1E3126] font-mono text-sm text-[#E8F3EC] focus:outline-none focus:border-[#22FF88]"
                    />
                  </div>
                </div>
                <div className="space-y-1">
                  <label className="block text-xs font-medium text-[#8AA396]">
                    Maksimal Kelompok (1–50)
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={50}
                    value={newMaxGroups}
                    onChange={(e) =>
                      setNewMaxGroups(
                        Math.min(50, Math.max(1, Number(e.target.value) || 1))
                      )
                    }
                    className="w-full min-h-[44px] px-3.5 rounded-xl bg-[#060907] border border-[#1E3126] font-mono text-sm text-[#E8F3EC] focus:outline-none focus:border-[#22FF88]"
                  />
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="min-h-[44px] px-4 rounded-xl border border-[#1E3126] text-sm text-[#E8F3EC] cursor-pointer"
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
                  className="min-h-[44px] px-5 rounded-xl bg-[#22FF88] text-[#041209] font-bold text-sm cursor-pointer"
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
