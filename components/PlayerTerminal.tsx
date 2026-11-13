'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import confetti from 'canvas-confetti';
import {
  collection,
  doc,
  onSnapshot,
  query,
  where,
} from 'firebase/firestore';
import {
  Volume2,
  Plus,
  Trash2,
  Send,
  Lightbulb,
  KeyRound,
  Trophy,
  Clock,
  ShieldAlert,
  CheckCircle2,
  LogOut,
  Lock,
} from 'lucide-react';
import { db, handleFirestoreError, OperationType, testFirestoreConnection } from '@/lib/firebase';
import {
  computeRemainingSeconds,
  formatClock,
  formatTimeWib,
  rankGroups,
} from '@/lib/game-utils';
import {
  activateAudioEngine,
  isAudioUnlocked,
  playCorrectKeySound,
  playVaultOpenedFanfare,
  playWrongKeySound,
} from '@/lib/sound';
import {
  GroupDoc,
  GroupPrivateStateResponse,
  HelpRequestDoc,
  PointLogDoc,
  SessionDoc,
} from '@/lib/types';
import { TypewriterCode } from './TypewriterCode';
import { AnimatedNumber } from './AnimatedNumber';
import { ProgressDots } from './ProgressDots';

interface SavedSessionAuth {
  sessionId: string;
  sessionCode: string;
  groupId: string;
  groupCode: string;
}

const STORAGE_KEY = 'hts_player_session_v1';

export function PlayerTerminal() {
  // Audio state (sound-only mode, no mute)
  const [audioReady, setAudioReady] = useState(() => isAudioUnlocked());

  // Entry / auth state
  const [entryMode, setEntryMode] = useState<'register' | 'rejoin'>('register');
  const [sessionCodeInput, setSessionCodeInput] = useState('');
  const [teamNameInput, setTeamNameInput] = useState('');
  const [membersInput, setMembersInput] = useState<string[]>([
    '',
    '',
    '',
    '',
    '',
    '',
    '',
  ]);
  const [groupCodeInput, setGroupCodeInput] = useState('');
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [showCodeModal, setShowCodeModal] = useState(false);

  // Saved identity
  const [savedAuth, setSavedAuth] = useState<SavedSessionAuth | null>(null);
  const [hydrating, setHydrating] = useState(true);
  const [confirmLeave, setConfirmLeave] = useState(false);

  // Live synced game state
  const [sessionDoc, setSessionDoc] = useState<SessionDoc | null>(null);
  const [groups, setGroups] = useState<GroupDoc[]>([]);
  const [requests, setRequests] = useState<HelpRequestDoc[]>([]);
  const [logs, setLogs] = useState<PointLogDoc[]>([]);
  const [privateState, setPrivateState] = useState<GroupPrivateStateResponse | null>(null);
  const [serverOffsetMs, setServerOffsetMs] = useState(0);
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Key submission & feedback state
  const [answerInput, setAnswerInput] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [feedbackBanner, setFeedbackBanner] = useState<{
    type: 'granted' | 'denied' | 'vault';
    title: string;
    detail: string;
  } | null>(null);
  const [shakeTrigger, setShakeTrigger] = useState(false);
  const [helpLoading, setHelpLoading] = useState<'hint' | 'emergency' | null>(null);
  const [helpMessage, setHelpMessage] = useState<string | null>(null);

  const prevSheetRef = useRef<number | null>(null);

  // Bootstrap default session & restore saved auth
  useEffect(() => {
    testFirestoreConnection().catch(() => {});

    let active = true;
    (async () => {
      try {
        const res = await fetch('/api/session/bootstrap');
        if (res.ok) {
          const data = await res.json();
          if (active && data.serverNowMs) {
            setServerOffsetMs(data.serverNowMs - Date.now());
          }
        }
      } catch {
        // ignore
      }

      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw) as SavedSessionAuth;
          if (parsed?.sessionId && parsed?.groupId && parsed?.groupCode) {
            if (active) setSavedAuth(parsed);
          }
        }
      } catch {
        localStorage.removeItem(STORAGE_KEY);
      } finally {
        if (active) setHydrating(false);
      }
    })();

    return () => {
      active = false;
    };
  }, []);

  // 1-second tick for timer & cooldown countdown
  useEffect(() => {
    const id = setInterval(() => {
      setNowMs(Date.now());
    }, 500);
    return () => clearInterval(id);
  }, []);

  const syncPrivateState = useCallback(async (auth: SavedSessionAuth) => {
    try {
      const res = await fetch('/api/group/state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: auth.sessionId,
          groupId: auth.groupId,
          groupCode: auth.groupCode,
        }),
      });
      if (res.status === 404 || res.status === 401) {
        localStorage.removeItem(STORAGE_KEY);
        setSavedAuth(null);
        setPrivateState(null);
        setAuthError('Sesi kelompok sudah di-reset atau tidak ditemukan. Silakan daftar kembali.');
        return;
      }
      if (!res.ok) return;
      const data = (await res.json()) as GroupPrivateStateResponse;
      setServerOffsetMs(data.serverNowMs - Date.now());
      setPrivateState(data);
    } catch {
      // transient network failure; keep state
    }
  }, []);

  // Realtime Firestore listeners when joined
  useEffect(() => {
    if (!savedAuth) return;

    Promise.resolve().then(() => syncPrivateState(savedAuth));

    const sessionRef = doc(db, 'sessions', savedAuth.sessionId);
    const unsubSession = onSnapshot(
      sessionRef,
      (snap) => {
        if (!snap.exists()) return;
        const data = { id: snap.id, ...(snap.data() as Omit<SessionDoc, 'id'>) };
        setSessionDoc(data);
        syncPrivateState(savedAuth);
      },
      (err) => handleFirestoreError(err, OperationType.GET, `sessions/${savedAuth.sessionId}`)
    );

    const groupsRef = collection(db, 'sessions', savedAuth.sessionId, 'groups');
    const unsubGroups = onSnapshot(
      groupsRef,
      (snap) => {
        const list: GroupDoc[] = snap.docs.map((d) => ({
          id: d.id,
          ...(d.data() as Omit<GroupDoc, 'id'>),
        }));
        setGroups(list);
      },
      (err) =>
        handleFirestoreError(err, OperationType.LIST, `sessions/${savedAuth.sessionId}/groups`)
    );

    const reqQuery = query(
      collection(db, 'sessions', savedAuth.sessionId, 'requests'),
      where('groupId', '==', savedAuth.groupId)
    );
    const unsubRequests = onSnapshot(
      reqQuery,
      (snap) => {
        const list: HelpRequestDoc[] = snap.docs
          .map((d) => ({ id: d.id, ...(d.data() as Omit<HelpRequestDoc, 'id'>) }))
          .sort((a, b) => b.createdAtMs - a.createdAtMs);
        setRequests(list);
        syncPrivateState(savedAuth);
      },
      (err) =>
        handleFirestoreError(err, OperationType.LIST, `sessions/${savedAuth.sessionId}/requests`)
    );

    const logsQuery = query(
      collection(db, 'sessions', savedAuth.sessionId, 'logs'),
      where('groupId', '==', savedAuth.groupId)
    );
    const unsubLogs = onSnapshot(
      logsQuery,
      (snap) => {
        const list: PointLogDoc[] = snap.docs
          .map((d) => ({ id: d.id, ...(d.data() as Omit<PointLogDoc, 'id'>) }))
          .sort((a, b) => b.createdAtMs - a.createdAtMs);
        setLogs(list);
        syncPrivateState(savedAuth);
      },
      (err) =>
        handleFirestoreError(err, OperationType.LIST, `sessions/${savedAuth.sessionId}/logs`)
    );

    return () => {
      unsubSession();
      unsubGroups();
      unsubRequests();
      unsubLogs();
    };
  }, [savedAuth, syncPrivateState]);

  const currentGroup = useMemo(() => {
    if (!savedAuth) return null;
    return groups.find((g) => g.id === savedAuth.groupId) || null;
  }, [groups, savedAuth]);

  // Track sheet progression to keep state fresh
  useEffect(() => {
    if (!currentGroup || !savedAuth) return;
    if (prevSheetRef.current !== null && prevSheetRef.current !== currentGroup.currentSheet) {
      syncPrivateState(savedAuth);
    }
    prevSheetRef.current = currentGroup.currentSheet;
  }, [currentGroup, savedAuth, syncPrivateState]);

  const syncedNowMs = nowMs + serverOffsetMs;
  const remainingSec = sessionDoc
    ? computeRemainingSeconds(sessionDoc, syncedNowMs)
    : 0;

  const activeCooldownUntilMs = Math.max(
    currentGroup?.cooldownUntilMs || 0,
    privateState?.cooldownUntilMs || 0
  );
  const cooldownSec = Math.max(0, Math.ceil((activeCooldownUntilMs - syncedNowMs) / 1000));

  const currentSheetNum = currentGroup?.currentSheet ?? privateState?.currentSheet ?? 1;
  const totalSheets = sessionDoc?.totalSheets ?? privateState?.totalSheets ?? 5;
  const displayPoints = currentGroup?.points ?? privateState?.points ?? 0;
  const completedSheets = currentGroup?.completedSheets ?? privateState?.completedSheets ?? 0;
  const isFinished = currentSheetNum > totalSheets;

  const unlockedEmergencyForCurrent = useMemo(() => {
    if (!privateState) return null;
    return (
      privateState.unlockedEmergencyKeys.find(
        (e) => e.sheetNumber === currentSheetNum
      ) || null
    );
  }, [privateState, currentSheetNum]);

  const unlockedHintForCurrent = useMemo(() => {
    if (!privateState) return null;
    return (
      privateState.unlockedHints.find((h) => h.sheetNumber === currentSheetNum) ||
      null
    );
  }, [privateState, currentSheetNum]);

  const pendingHintReq = useMemo(
    () =>
      requests.find(
        (r) =>
          r.type === 'hint' &&
          r.sheetNumber === currentSheetNum &&
          r.status === 'pending'
      ) || null,
    [requests, currentSheetNum]
  );

  const pendingEmergencyReq = useMemo(
    () =>
      requests.find(
        (r) =>
          r.type === 'emergency' &&
          r.sheetNumber === currentSheetNum &&
          r.status === 'pending'
      ) || null,
    [requests, currentSheetNum]
  );

  const rejectedHintReq = useMemo(
    () =>
      requests.find(
        (r) =>
          r.type === 'hint' &&
          r.sheetNumber === currentSheetNum &&
          r.status === 'rejected'
      ) || null,
    [requests, currentSheetNum]
  );

  const rejectedEmergencyReq = useMemo(
    () =>
      requests.find(
        (r) =>
          r.type === 'emergency' &&
          r.sheetNumber === currentSheetNum &&
          r.status === 'rejected'
      ) || null,
    [requests, currentSheetNum]
  );

  const rankedLeaderboard = useMemo(() => rankGroups(groups), [groups]);
  const myRank = useMemo(() => {
    if (!savedAuth) return null;
    const idx = rankedLeaderboard.findIndex((g) => g.id === savedAuth.groupId);
    return idx >= 0 ? idx + 1 : null;
  }, [rankedLeaderboard, savedAuth]);

  const handleActivateAudio = async () => {
    await activateAudioEngine();
    setAudioReady(true);
  };

  const handleAddMember = () => {
    if (membersInput.length < 20) {
      setMembersInput((prev) => [...prev, '']);
    }
  };

  const handleRemoveMember = (index: number) => {
    if (membersInput.length > 2) {
      setMembersInput((prev) => prev.filter((_, idx) => idx !== index));
    }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    const cleanedMembers = membersInput.map((m) => m.trim()).filter(Boolean);
    if (!/^\d{4}$/.test(sessionCodeInput.trim())) {
      setAuthError('Masukkan Kode Sesi 4 digit angka.');
      return;
    }
    if (!teamNameInput.trim()) {
      setAuthError('Masukkan nama kelompok.');
      return;
    }
    if (cleanedMembers.length < 2 || cleanedMembers.length > 20) {
      setAuthError('Masukkan minimal 2 dan maksimal 20 nama anggota.');
      return;
    }

    if (!audioReady) {
      activateAudioEngine()
        .then(() => setAudioReady(true))
        .catch(() => {});
    }

    setAuthLoading(true);
    try {
      const res = await fetch('/api/group/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionCode: sessionCodeInput.trim(),
          teamName: teamNameInput.trim(),
          members: cleanedMembers,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setAuthError(data.error || 'Pendaftaran gagal.');
        return;
      }

      const authObj: SavedSessionAuth = {
        sessionId: data.sessionId,
        sessionCode: data.sessionCode,
        groupId: data.groupId,
        groupCode: data.groupCode,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(authObj));
      setSavedAuth(authObj);
      setShowCodeModal(true);
    } catch {
      setAuthError('Gagal terhubung ke server.');
    } finally {
      setAuthLoading(false);
    }
  };

  const handleRejoin = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    if (!/^\d{4}$/.test(sessionCodeInput.trim())) {
      setAuthError('Masukkan Kode Sesi 4 digit angka.');
      return;
    }
    if (!/^[a-zA-Z0-9]{4}$/.test(groupCodeInput.trim())) {
      setAuthError('Masukkan Kode Kelompok 4 karakter.');
      return;
    }

    if (!audioReady) {
      activateAudioEngine()
        .then(() => setAudioReady(true))
        .catch(() => {});
    }

    setAuthLoading(true);
    try {
      const res = await fetch('/api/group/rejoin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionCode: sessionCodeInput.trim(),
          groupCode: groupCodeInput.trim().toUpperCase(),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setAuthError(data.error || 'Gagal masuk kembali.');
        return;
      }

      const authObj: SavedSessionAuth = {
        sessionId: data.sessionId,
        sessionCode: data.sessionCode,
        groupId: data.groupId,
        groupCode: data.groupCode,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(authObj));
      setSavedAuth(authObj);
    } catch {
      setAuthError('Gagal terhubung ke server.');
    } finally {
      setAuthLoading(false);
    }
  };

  const handleLeaveGroup = () => {
    localStorage.removeItem(STORAGE_KEY);
    setSavedAuth(null);
    setSessionDoc(null);
    setPrivateState(null);
    setGroups([]);
    setLogs([]);
    setRequests([]);
    setConfirmLeave(false);
    setShowCodeModal(false);
  };

  const fireConfettiBurst = (isVault: boolean) => {
    if (
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      return;
    }
    if (isVault) {
      confetti({ particleCount: 110, spread: 90, origin: { y: 0.55 }, colors: ['#22FF88', '#FFFFFF', '#00E5FF', '#FFB020'] });
      setTimeout(() => {
        confetti({ particleCount: 85, angle: 60, spread: 70, origin: { x: 0.1, y: 0.6 }, colors: ['#22FF88', '#00E5FF', '#FFB020'] });
        confetti({ particleCount: 85, angle: 120, spread: 70, origin: { x: 0.9, y: 0.6 }, colors: ['#22FF88', '#00E5FF', '#FFB020'] });
      }, 320);
    } else {
      confetti({
        particleCount: 70,
        spread: 68,
        origin: { y: 0.6 },
        colors: ['#22FF88', '#00FF66', '#E6F4EC'],
      });
    }
  };

  const handleSubmitKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!savedAuth || submitting || cooldownSec > 0) return;

    setSubmitError(null);
    const trimmed = answerInput.trim();
    if (!trimmed) {
      setSubmitError('Masukkan kode kunci terlebih dahulu.');
      return;
    }

    if (!audioReady) {
      await activateAudioEngine();
      setAudioReady(true);
    }

    setSubmitting(true);
    try {
      const res = await fetch('/api/group/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: savedAuth.sessionId,
          groupId: savedAuth.groupId,
          groupCode: savedAuth.groupCode,
          answerInput: trimmed,
        }),
      });
      const data = await res.json();

      if (!res.ok) {
        setSubmitError(data.error || 'Pengiriman gagal.');
        if (data.cooldownUntilMs && data.serverNowMs) {
          setServerOffsetMs(data.serverNowMs - Date.now());
          setPrivateState((prev) =>
            prev ? { ...prev, cooldownUntilMs: data.cooldownUntilMs } : prev
          );
        }
        return;
      }

      setServerOffsetMs(data.serverNowMs - Date.now());

      if (data.correct) {
        setAnswerInput('');
        if (data.vaultOpened) {
          playVaultOpenedFanfare();
          fireConfettiBurst(true);
          setFeedbackBanner({
            type: 'vault',
            title: 'VAULT OPENED',
            detail: `Brankas terbuka! +${data.pointsAwarded} poin${
              data.bonusAwarded > 0 ? ` (termasuk bonus +${data.bonusAwarded})` : ''
            }`,
          });
        } else {
          playCorrectKeySound();
          fireConfettiBurst(false);
          setFeedbackBanner({
            type: 'granted',
            title: 'ACCESS GRANTED',
            detail: `Kunci benar! +${data.pointsAwarded} poin${
              data.bonusAwarded > 0 ? ` (bonus tercepat +${data.bonusAwarded})` : ''
            }`,
          });
          setTimeout(() => {
            setFeedbackBanner((curr) => (curr?.type === 'granted' ? null : curr));
          }, 3400);
        }
        await syncPrivateState(savedAuth);
      } else {
        playWrongKeySound();
        setShakeTrigger(true);
        setTimeout(() => setShakeTrigger(false), 520);
        setPrivateState((prev) =>
          prev ? { ...prev, cooldownUntilMs: data.cooldownUntilMs } : prev
        );
        setFeedbackBanner({
          type: 'denied',
          title: 'ACCESS DENIED',
          detail: `Kode salah (${data.delta} poin). Tombol dikunci 10 detik.`,
        });
        setTimeout(() => {
          setFeedbackBanner((curr) => (curr?.type === 'denied' ? null : curr));
        }, 3200);
      }
    } catch {
      setSubmitError('Koneksi terputus. Coba kirim ulang.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleRequestHelp = async (type: 'hint' | 'emergency') => {
    if (!savedAuth || helpLoading) return;
    setHelpMessage(null);
    setHelpLoading(type);
    try {
      const res = await fetch('/api/group/request-help', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: savedAuth.sessionId,
          groupId: savedAuth.groupId,
          groupCode: savedAuth.groupCode,
          type,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setHelpMessage(data.error || 'Gagal mengirim permintaan.');
        return;
      }
      setHelpMessage(
        data.alreadyPending
          ? 'Permintaan sudah tercatat. Menunggu persetujuan admin.'
          : type === 'hint'
            ? 'Permintaan petunjuk terkirim. Menunggu admin.'
            : 'Permintaan kunci darurat terkirim. Menunggu admin.'
      );
    } catch {
      setHelpMessage('Gagal terhubung ke server.');
    } finally {
      setHelpLoading(null);
    }
  };

  const timerColor =
    remainingSec <= 60
      ? 'text-[#FF3B5C]'
      : remainingSec <= 300
        ? 'text-[#FFB020]'
        : 'text-[#22FF88]';

  const canSubmitDespiteTimeout = Boolean(unlockedEmergencyForCurrent);
  const timeExpiredLock =
    sessionDoc?.status === 'running' && remainingSec <= 0 && !canSubmitDespiteTimeout;

  return (
    <div className="min-h-screen flex flex-col">
      {/* Top Bar */}
      <header className="sticky top-0 z-30 border-b border-[#1B2A21] bg-[#070A08]/92 backdrop-blur-md">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <span className="font-mono text-sm sm:text-base font-bold tracking-wider text-[#22FF88] whitespace-nowrap shrink-0">
              HACK THE SYSTEM
            </span>
            <span className="hidden md:inline text-xs text-[#8AA396] whitespace-nowrap">
              Reading Escape Room
            </span>
          </div>

          <div className="flex items-center gap-4 shrink-0">
            {!savedAuth && (
              <nav className="hidden sm:flex items-center gap-5 text-sm text-[#8AA396]">
                <Link
                  href="/layar"
                  className="hover:text-[#E8F3EC] transition-colors whitespace-nowrap shrink-0"
                >
                  Layar Proyektor
                </Link>
                <Link
                  href="/admin"
                  className="hover:text-[#E8F3EC] transition-colors whitespace-nowrap shrink-0"
                >
                  Panel Admin
                </Link>
              </nav>
            )}

            {audioReady ? (
              <span className="min-h-[44px] px-2.5 inline-flex items-center gap-1.5 text-xs font-medium text-[#22FF88] whitespace-nowrap shrink-0">
                <Volume2 className="w-4 h-4 shrink-0" />
                <span>Mode Suara</span>
              </span>
            ) : (
              <button
                type="button"
                onClick={handleActivateAudio}
                className="min-h-[40px] px-3.5 rounded-lg border border-[#22FF88]/45 bg-[#0C1911] text-[#22FF88] hover:bg-[#12261A] text-xs font-semibold inline-flex items-center gap-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Volume2 className="w-4 h-4 shrink-0" />
                <span>Aktifkan Suara</span>
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 w-full max-w-6xl mx-auto px-4 sm:px-6 py-7 sm:py-10">
        {hydrating ? (
          <div className="max-w-lg mx-auto py-16 text-center font-mono text-sm text-[#8AA396]">
            Memuat terminal...
          </div>
        ) : !savedAuth ? (
          /* ENTRY / REGISTRATION VIEW — ASYMMETRIC ARCHITECTURAL SPLIT */
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-12 items-start">
            {/* Left Editorial Mission Brief */}
            <div className="lg:col-span-5 space-y-8 lg:pt-2">
              <div className="space-y-3">
                <p className="font-mono text-xs tracking-[0.18em] text-[#22FF88]">
                  Terminal Kelompok
                </p>
                <h1 className="text-3xl sm:text-4xl lg:text-[2.75rem] leading-[1.08] font-bold tracking-tight text-[#E8F3EC] text-balance">
                  Pecahkan Kode, Buka Brankas Bersama.
                </h1>
                <p className="text-sm sm:text-base leading-relaxed text-[#8AA396]">
                  Satu perangkat per kelompok untuk lomba membaca bahasa Inggris. Cari lembar teks terlipat di ruangan, selesaikan soal di kertas, lalu masukkan kode kunci di sini.
                </p>
              </div>

              {/* Unboxed numbered steps with hairline dividers */}
              <div className="border-t border-[#1B2A21] divide-y divide-[#17231C]">
                <div className="py-4 flex items-start gap-4">
                  <span className="font-mono text-xs font-bold text-[#22FF88] pt-0.5 tabular-nums">
                    01
                  </span>
                  <div className="space-y-0.5">
                    <h2 className="text-sm font-semibold text-[#E8F3EC]">
                      Daftar dengan Kode Sesi
                    </h2>
                    <p className="text-xs leading-relaxed text-[#8AA396]">
                      Masukkan Kode Sesi 4 digit dari panitia dan nama seluruh anggota (minimal 2, mendukung 7+ anggota).
                    </p>
                  </div>
                </div>

                <div className="py-4 flex items-start gap-4">
                  <span className="font-mono text-xs font-bold text-[#22FF88] pt-0.5 tabular-nums">
                    02
                  </span>
                  <div className="space-y-0.5">
                    <h2 className="text-sm font-semibold text-[#E8F3EC]">
                      Ikuti Kode Lembar Terminal
                    </h2>
                    <p className="text-xs leading-relaxed text-[#8AA396]">
                      Setiap kode kunci yang benar membuka kode lembar berikutnya dan menambah poin otomatis di papan skor.
                    </p>
                  </div>
                </div>

                <div className="py-4 flex items-start gap-4">
                  <span className="font-mono text-xs font-bold text-[#22FF88] pt-0.5 tabular-nums">
                    03
                  </span>
                  <div className="space-y-0.5">
                    <h2 className="text-sm font-semibold text-[#E8F3EC]">
                      Simpan Kode Masuk Kembali
                    </h2>
                    <p className="text-xs leading-relaxed text-[#8AA396]">
                      Setelah mendaftar, catat Kode Kelompok 4 karakter untuk memulihkan sesi jika browser HP tertutup.
                    </p>
                  </div>
                </div>
              </div>

              <div className="hidden lg:flex items-center gap-6 text-xs text-[#8AA396] pt-1">
                <Link href="/layar" className="hover:text-[#22FF88] transition-colors whitespace-nowrap shrink-0">
                  Buka Layar Proyektor
                </Link>
                <span aria-hidden="true" className="text-[#2D4437]">·</span>
                <Link href="/admin" className="hover:text-[#22FF88] transition-colors whitespace-nowrap shrink-0">
                  Masuk Panel Admin
                </Link>
              </div>
            </div>

            {/* Right Registration / Rejoin Surface */}
            <div className="lg:col-span-7">
              <div className="rounded-2xl border border-[#1B2A21] bg-[#0B110D] p-5 sm:p-7 space-y-6">
                {/* Segmented Tabs */}
                <div className="grid grid-cols-2 gap-1.5 p-1 rounded-xl bg-[#060907] border border-[#17231C]">
                  <button
                    type="button"
                    onClick={() => {
                      setEntryMode('register');
                      setAuthError(null);
                    }}
                    className={`min-h-[44px] rounded-lg text-sm font-semibold transition-colors whitespace-nowrap cursor-pointer ${
                      entryMode === 'register'
                        ? 'bg-[#22FF88] text-[#041209]'
                        : 'text-[#8AA396] hover:text-[#E8F3EC]'
                    }`}
                  >
                    Daftar Kelompok
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setEntryMode('rejoin');
                      setAuthError(null);
                    }}
                    className={`min-h-[44px] rounded-lg text-sm font-semibold transition-colors whitespace-nowrap cursor-pointer ${
                      entryMode === 'rejoin'
                        ? 'bg-[#22FF88] text-[#041209]'
                        : 'text-[#8AA396] hover:text-[#E8F3EC]'
                    }`}
                  >
                    Masuk Kembali
                  </button>
                </div>

                {authError && (
                  <div className="p-3.5 rounded-xl border border-[#FF3B5C]/45 bg-[#FF3B5C]/10 text-sm text-[#FF9BAE] flex items-start gap-2.5">
                    <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5 text-[#FF3B5C]" />
                    <span>{authError}</span>
                  </div>
                )}

                {entryMode === 'register' ? (
                  <form onSubmit={handleRegister} className="space-y-5">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div className="space-y-1.5">
                        <label
                          htmlFor="reg-session-code"
                          className="block text-xs font-medium text-[#8AA396]"
                        >
                          Kode Sesi (4 Digit)
                        </label>
                        <input
                          id="reg-session-code"
                          type="text"
                          inputMode="numeric"
                          maxLength={4}
                          value={sessionCodeInput}
                          onChange={(e) =>
                            setSessionCodeInput(e.target.value.replace(/\D/g, '').slice(0, 4))
                          }
                          placeholder="Contoh: 4821"
                          className="w-full min-h-[48px] px-4 rounded-xl bg-[#060907] border border-[#1E3126] font-mono text-lg tracking-[0.2em] text-[#E8F3EC] placeholder:text-[#4C6557] placeholder:tracking-normal placeholder:text-sm focus:outline-none focus:border-[#22FF88]"
                          required
                        />
                      </div>

                      <div className="space-y-1.5">
                        <label
                          htmlFor="reg-team-name"
                          className="block text-xs font-medium text-[#8AA396]"
                        >
                          Nama Kelompok
                        </label>
                        <input
                          id="reg-team-name"
                          type="text"
                          maxLength={50}
                          value={teamNameInput}
                          onChange={(e) => setTeamNameInput(e.target.value)}
                          placeholder="Contoh: Alpha Readers"
                          className="w-full min-h-[48px] px-4 rounded-xl bg-[#060907] border border-[#1E3126] text-base text-[#E8F3EC] placeholder:text-[#4C6557] focus:outline-none focus:border-[#22FF88]"
                          required
                        />
                      </div>
                    </div>

                    <div className="space-y-2.5 pt-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-medium text-[#8AA396]">
                          Nama Anggota (Min. 2 · Mendukung 7+ Orang)
                        </span>
                        {membersInput.length < 20 && (
                          <button
                            type="button"
                            onClick={handleAddMember}
                            className="min-h-[36px] px-3 rounded-lg border border-[#1E3126] text-xs font-semibold text-[#22FF88] hover:bg-[#101D15] inline-flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer"
                          >
                            <Plus className="w-3.5 h-3.5" />
                            <span>Tambah Anggota</span>
                          </button>
                        )}
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                        {membersInput.map((member, idx) => (
                          <div key={idx} className="flex items-center gap-2">
                            <input
                              type="text"
                              maxLength={40}
                              value={member}
                              onChange={(e) => {
                                const next = [...membersInput];
                                next[idx] = e.target.value;
                                setMembersInput(next);
                              }}
                              placeholder={`Anggota ${idx + 1}${idx >= 2 ? ' (opsional)' : ''}`}
                              className="flex-1 min-w-0 min-h-[44px] px-3.5 rounded-xl bg-[#060907] border border-[#1E3126] text-sm text-[#E8F3EC] placeholder:text-[#4C6557] focus:outline-none focus:border-[#22FF88]"
                              required={idx < 2}
                            />
                            {membersInput.length > 2 && (
                              <button
                                type="button"
                                onClick={() => handleRemoveMember(idx)}
                                aria-label={`Hapus anggota ${idx + 1}`}
                                className="min-h-[44px] min-w-[44px] rounded-xl border border-[#1E3126] text-[#8AA396] hover:text-[#FF3B5C] hover:border-[#FF3B5C]/40 flex items-center justify-center shrink-0 cursor-pointer"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>

                    <button
                      type="submit"
                      disabled={authLoading}
                      className="w-full min-h-[52px] px-6 py-3 rounded-xl bg-[#22FF88] text-[#041209] font-bold text-base hover:bg-[#3EFF99] active:scale-[0.99] transition-all disabled:opacity-50 cursor-pointer"
                    >
                      {authLoading ? 'Mendaftarkan Kelompok...' : 'Daftar & Masuk Ruang Tunggu'}
                    </button>
                  </form>
                ) : (
                  <form onSubmit={handleRejoin} className="space-y-4">
                    <div className="space-y-1.5">
                      <label
                        htmlFor="rejoin-session-code"
                        className="block text-xs font-medium text-[#8AA396]"
                      >
                        Kode Sesi (4 Digit)
                      </label>
                      <input
                        id="rejoin-session-code"
                        type="text"
                        inputMode="numeric"
                        maxLength={4}
                        value={sessionCodeInput}
                        onChange={(e) =>
                          setSessionCodeInput(e.target.value.replace(/\D/g, '').slice(0, 4))
                        }
                        placeholder="Contoh: 4821"
                        className="w-full min-h-[48px] px-4 rounded-xl bg-[#060907] border border-[#1E3126] font-mono text-lg tracking-[0.2em] text-[#E8F3EC] placeholder:text-[#4C6557] placeholder:tracking-normal placeholder:text-sm focus:outline-none focus:border-[#22FF88]"
                        required
                      />
                    </div>

                    <div className="space-y-1.5">
                      <label
                        htmlFor="rejoin-group-code"
                        className="block text-xs font-medium text-[#8AA396]"
                      >
                        Kode Kelompok (4 Karakter)
                      </label>
                      <input
                        id="rejoin-group-code"
                        type="text"
                        maxLength={4}
                        value={groupCodeInput}
                        onChange={(e) =>
                          setGroupCodeInput(
                            e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4)
                          )
                        }
                        placeholder="Contoh: K7M2"
                        className="w-full min-h-[48px] px-4 rounded-xl bg-[#060907] border border-[#1E3126] font-mono text-lg tracking-[0.25em] text-[#22FF88] placeholder:text-[#4C6557] placeholder:tracking-normal placeholder:text-sm focus:outline-none focus:border-[#22FF88]"
                        required
                      />
                    </div>

                    <button
                      type="submit"
                      disabled={authLoading}
                      className="w-full min-h-[52px] px-6 py-3 rounded-xl bg-[#22FF88] text-[#041209] font-bold text-base hover:bg-[#3EFF99] active:scale-[0.99] transition-all disabled:opacity-50 cursor-pointer"
                    >
                      {authLoading ? 'Memulihkan Sesi...' : 'Masuk Kembali ke Kelompok'}
                    </button>
                  </form>
                )}
              </div>

              <div className="flex lg:hidden flex-wrap items-center justify-center gap-6 text-sm text-[#8AA396] pt-5">
                <Link href="/layar" className="hover:text-[#22FF88] transition-colors">
                  Buka Layar Proyektor
                </Link>
                <span aria-hidden="true" className="text-[#2D4437]">·</span>
                <Link href="/admin" className="hover:text-[#22FF88] transition-colors">
                  Masuk Panel Admin
                </Link>
              </div>
            </div>
          </div>
        ) : (
          /* LOGGED-IN GROUP GAMEPLAY */
          <div className={`space-y-6 max-w-5xl mx-auto ${shakeTrigger ? 'animate-terminal-shake' : ''}`}>
            {/* One-time Group Code Modal after registration */}
            {showCodeModal && (
              <div className="rounded-2xl border border-[#22FF88]/50 bg-[#0B1710] p-5 sm:p-6 space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div className="space-y-1">
                    <p className="font-mono text-xs tracking-wider text-[#22FF88]">
                      Pendaftaran Berhasil · Simpan Kode Ini
                    </p>
                    <h2 className="text-lg font-bold text-[#E8F3EC]">
                      Kode Kelompok Anda
                    </h2>
                    <p className="text-sm text-[#8AA396]">
                      Catat kode ini untuk masuk kembali jika browser HP tertutup atau refresh.
                    </p>
                  </div>
                  <div className="px-5 py-3 rounded-xl bg-[#050806] border border-[#22FF88]/45 text-center shrink-0">
                    <span className="font-mono text-3xl font-bold tracking-[0.25em] text-[#22FF88] tabular-nums">
                      {savedAuth.groupCode}
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setShowCodeModal(false)}
                  className="min-h-[44px] px-5 py-2 rounded-xl bg-[#22FF88] text-[#041209] font-semibold text-sm hover:bg-[#3EFF99] cursor-pointer"
                >
                  Saya Sudah Catat
                </button>
              </div>
            )}

            {/* Big AKTIFKAN SUARA Prompt when not yet unlocked in this tab */}
            {!audioReady && (
              <button
                type="button"
                onClick={handleActivateAudio}
                className="w-full min-h-[60px] px-6 py-4 rounded-2xl bg-[#22FF88] text-[#041209] font-bold text-base sm:text-lg flex items-center justify-center gap-3 hover:bg-[#3EFF99] active:scale-[0.99] transition-all cursor-pointer"
              >
                <Volume2 className="w-6 h-6 shrink-0" />
                <span>AKTIFKAN SUARA (TEKAN SEKALI)</span>
              </button>
            )}

            {/* Top HUD Summary — Single elevation with hairline dividers */}
            <section className="rounded-2xl border border-[#1B2A21] bg-[#0B110D] p-5 sm:p-6">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-5">
                <div className="space-y-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-[#8AA396]">
                    <span>
                      Sesi <strong className="font-mono text-[#E8F3EC] tabular-nums">{savedAuth.sessionCode}</strong>
                    </span>
                    <span aria-hidden="true" className="text-[#2D4437]">·</span>
                    <span>
                      Kode Masuk <strong className="font-mono text-[#E8F3EC]">{savedAuth.groupCode}</strong>
                    </span>
                    {audioReady && (
                      <>
                        <span aria-hidden="true" className="text-[#2D4437]">·</span>
                        <span className="text-[#22FF88] font-medium">Mode Suara Aktif</span>
                      </>
                    )}
                  </div>
                  <h1 className="text-xl sm:text-2xl font-bold text-[#E8F3EC] truncate">
                    {currentGroup?.teamName || privateState?.teamName || 'Memuat...'}
                  </h1>
                  <p className="text-xs sm:text-sm text-[#8AA396] truncate">
                    {(currentGroup?.members || privateState?.members || []).join(' · ')}
                  </p>
                </div>

                <div className="grid grid-cols-3 divide-x divide-[#17231C] pt-3 md:pt-0 border-t md:border-t-0 border-[#17231C] shrink-0">
                  <div className="pr-4 sm:pr-6">
                    <p className="text-xs text-[#8AA396]">Sisa Waktu</p>
                    <p className={`font-mono text-2xl sm:text-3xl font-bold tabular-nums ${timerColor}`}>
                      {sessionDoc ? formatClock(remainingSec) : '--:--'}
                    </p>
                  </div>
                  <div className="px-4 sm:px-6">
                    <p className="text-xs text-[#8AA396]">Poin</p>
                    <p className="font-mono text-2xl sm:text-3xl font-bold text-[#E8F3EC] tabular-nums">
                      <AnimatedNumber value={displayPoints} />
                    </p>
                  </div>
                  <div className="pl-4 sm:pl-6">
                    <p className="text-xs text-[#8AA396]">Kemajuan</p>
                    <div className="pt-2">
                      <ProgressDots completed={completedSheets} total={totalSheets} />
                    </div>
                  </div>
                </div>
              </div>
            </section>

            {/* Feedback Overlay / Banner */}
            {feedbackBanner && (
              <div
                role="status"
                className={`relative overflow-hidden rounded-2xl border p-5 text-center space-y-1.5 ${
                  feedbackBanner.type === 'denied'
                    ? 'border-[#FF3B5C]/70 bg-[#1B0B0F] text-[#FF9BAE]'
                    : 'border-[#22FF88]/70 bg-[#0B1D13] text-[#22FF88]'
                }`}
              >
                <div
                  aria-hidden="true"
                  className={`absolute inset-x-0 top-0 h-[2px] ${
                    feedbackBanner.type === 'denied' ? 'bg-[#FF3B5C]' : 'bg-[#22FF88]'
                  }`}
                />
                <p className="font-mono text-2xl sm:text-3xl font-bold tracking-widest">
                  {feedbackBanner.title}
                </p>
                <p className="text-sm sm:text-base font-medium text-[#E8F3EC]">
                  {feedbackBanner.detail}
                </p>
              </div>
            )}

            {/* Main Game Area based on Session Status & Completion */}
            {sessionDoc?.status === 'waiting' ? (
              <section className="rounded-2xl border border-[#1B2A21] bg-[#0B110D] p-7 sm:p-12 text-center space-y-5">
                <div className="w-12 h-12 rounded-xl bg-[#0E1E15] border border-[#22FF88]/30 flex items-center justify-center mx-auto text-[#22FF88]">
                  <Clock className="w-6 h-6" />
                </div>
                <div className="space-y-2 max-w-md mx-auto">
                  <h2 className="text-xl sm:text-2xl font-bold text-[#E8F3EC]">
                    Ruang Tunggu Kelompok
                  </h2>
                  <p className="text-sm sm:text-base leading-relaxed text-[#8AA396]">
                    Menunggu admin menekan tombol MULAI. Pastikan suara sudah diaktifkan di HP agar efek bunyi kemenangan dan peringatan terdengar jelas.
                  </p>
                </div>
                {audioReady && (
                  <button
                    type="button"
                    onClick={handleActivateAudio}
                    className="min-h-[44px] px-4 py-2 rounded-xl border border-[#1E3126] text-sm font-medium text-[#22FF88] hover:bg-[#101D15] inline-flex items-center gap-2 cursor-pointer"
                  >
                    <Volume2 className="w-4 h-4" />
                    <span>Tes Suara</span>
                  </button>
                )}
              </section>
            ) : isFinished ? (
              /* VAULT OPENED & LEADERBOARD */
              <div className="space-y-6">
                <section className="relative overflow-hidden rounded-2xl border border-[#22FF88]/50 bg-[#0B1911] p-7 sm:p-10 text-center space-y-4">
                  <div aria-hidden="true" className="absolute inset-x-0 top-0 h-[2px] bg-[#22FF88]" />
                  <div className="w-14 h-14 rounded-xl bg-[#22FF88]/15 border border-[#22FF88]/45 flex items-center justify-center mx-auto text-[#22FF88]">
                    <Trophy className="w-7 h-7" />
                  </div>
                  <div className="space-y-1.5">
                    <p className="font-mono text-xs tracking-[0.2em] text-[#22FF88]">
                      Semua Lembar Terpecahkan
                    </p>
                    <h2 className="font-mono text-3xl sm:text-5xl font-bold tracking-wider text-[#22FF88]">
                      VAULT OPENED
                    </h2>
                    <p className="text-sm sm:text-base text-[#E8F3EC]">
                      Selamat! Poin akhir kelompok Anda:{' '}
                      <strong className="font-mono text-[#22FF88] tabular-nums">{displayPoints}</strong>
                      {myRank ? ` · Peringkat sementara #${myRank}` : ''}
                    </p>
                  </div>
                </section>

                <section className="rounded-2xl border border-[#1B2A21] bg-[#0B110D] overflow-hidden">
                  <div className="px-5 sm:px-6 py-4 border-b border-[#17231C]">
                    <h3 className="text-base font-bold text-[#E8F3EC]">
                      Peringkat Kelompok Saat Ini
                    </h3>
                  </div>
                  <div className="divide-y divide-[#17231C]">
                    {rankedLeaderboard.map((g, idx) => {
                      const isMe = g.id === savedAuth.groupId;
                      return (
                        <div
                          key={g.id}
                          className={`px-5 sm:px-6 py-3.5 flex items-center justify-between gap-4 ${
                            isMe ? 'bg-[#0C1911] text-[#22FF88]' : 'text-[#E8F3EC]'
                          }`}
                        >
                          <div className="flex items-center gap-3 min-w-0">
                            <span className="font-mono text-sm font-bold w-8 tabular-nums">
                              #{idx + 1}
                            </span>
                            <div className="min-w-0">
                              <p className="font-semibold truncate">
                                {g.teamName} {isMe ? '(Anda)' : ''}
                              </p>
                              <div className="mt-1">
                                <ProgressDots completed={g.completedSheets} total={totalSheets} />
                              </div>
                            </div>
                          </div>
                          <span className="font-mono text-lg font-bold tabular-nums shrink-0">
                            {g.points} pts
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </section>
              </div>
            ) : (
              /* ACTIVE MISSION TERMINAL */
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                <div className="lg:col-span-7 space-y-5">
                  {/* Paused / Ended Banner */}
                  {sessionDoc?.status === 'paused' && (
                    <div className="p-4 rounded-xl border border-[#FFB020]/50 bg-[#1B1408] text-[#FFD07A] text-sm font-medium">
                      Sesi sedang dijeda oleh admin. Tunggu hingga admin melanjutkan sesi.
                    </div>
                  )}
                  {sessionDoc?.status === 'ended' && (
                    <div className="p-4 rounded-xl border border-[#FF3B5C]/50 bg-[#1B0B0F] text-[#FF9BAE] text-sm font-medium">
                      Sesi telah diakhiri oleh admin. Terima kasih telah berpartisipasi!
                    </div>
                  )}
                  {timeExpiredLock && (
                    <div className="p-4 rounded-xl border border-[#FF3B5C]/50 bg-[#1B0B0F] text-[#FF9BAE] text-sm font-medium">
                      Waktu sesi telah habis. Pengiriman kode dikunci kecuali mendapat Kunci Darurat dari admin.
                    </div>
                  )}

                  {/* Sheet Target & Key Form */}
                  <section className="rounded-2xl border border-[#1B2A21] bg-[#0B110D] p-5 sm:p-7 space-y-6">
                    <div className="flex items-center justify-between text-xs text-[#8AA396] pb-3 border-b border-[#17231C]">
                      <span className="font-mono tabular-nums">
                        Tahap {currentSheetNum} dari {totalSheets}
                      </span>
                      <span>Tersedia di ruangan</span>
                    </div>

                    {privateState?.currentSheetCode ? (
                      <TypewriterCode code={privateState.currentSheetCode} />
                    ) : (
                      <div className="py-6 text-center font-mono text-sm text-[#8AA396]">
                        Memuat kode lembar...
                      </div>
                    )}

                    <form onSubmit={handleSubmitKey} className="space-y-4 pt-2">
                      <div className="space-y-1.5">
                        <label
                          htmlFor="key-input"
                          className="block text-xs font-medium text-[#8AA396]"
                        >
                          Masukkan Kode Kunci
                        </label>
                        <input
                          id="key-input"
                          type="text"
                          autoComplete="off"
                          autoCapitalize="characters"
                          value={answerInput}
                          onChange={(e) => setAnswerInput(e.target.value)}
                          placeholder="Contoh: 145 atau 7-2024-09 atau OPEN"
                          disabled={
                            submitting ||
                            sessionDoc?.status === 'paused' ||
                            sessionDoc?.status === 'ended' ||
                            timeExpiredLock
                          }
                          className="w-full min-h-[54px] px-4 rounded-xl bg-[#060907] border border-[#1E3126] font-mono text-xl tracking-wider text-center text-[#E8F3EC] placeholder:text-[#4C6557] placeholder:text-sm placeholder:tracking-normal focus:outline-none focus:border-[#22FF88] disabled:opacity-50"
                        />
                        <p className="text-xs text-[#8AA396] text-center">
                          Huruf besar/kecil, spasi, dan tanda strip (-) otomatis diabaikan.
                        </p>
                      </div>

                      {submitError && (
                        <p className="text-sm text-[#FF9BAE] text-center font-medium">
                          {submitError}
                        </p>
                      )}

                      <button
                        type="submit"
                        disabled={
                          submitting ||
                          cooldownSec > 0 ||
                          sessionDoc?.status !== 'running' ||
                          timeExpiredLock
                        }
                        className={`w-full min-h-[56px] px-6 py-3.5 rounded-xl font-bold text-base sm:text-lg inline-flex items-center justify-center gap-2.5 transition-all cursor-pointer ${
                          cooldownSec > 0
                            ? 'bg-[#261115] border border-[#FF3B5C]/45 text-[#FF9BAE] cursor-not-allowed'
                            : 'bg-[#22FF88] text-[#041209] hover:bg-[#3EFF99] active:scale-[0.99] disabled:opacity-50'
                        }`}
                      >
                        {cooldownSec > 0 ? (
                          <>
                            <Lock className="w-5 h-5" />
                            <span className="font-mono tabular-nums">
                              TERKUNCI ({cooldownSec} dtk)
                            </span>
                          </>
                        ) : (
                          <>
                            <Send className="w-5 h-5" />
                            <span>{submitting ? 'MEMERIKSA...' : 'KIRIM'}</span>
                          </>
                        )}
                      </button>
                    </form>
                  </section>
                </div>

                {/* Right Column: Hints & Emergency Keys */}
                <div className="lg:col-span-5 space-y-5">
                  <section className="rounded-2xl border border-[#1B2A21] bg-[#0B110D] p-5 sm:p-6 space-y-4">
                    <div className="space-y-1 pb-3 border-b border-[#17231C]">
                      <h2 className="text-base font-bold text-[#E8F3EC]">
                        Bantuan Admin
                      </h2>
                      <p className="text-xs leading-relaxed text-[#8AA396]">
                        Gunakan jika kelompok benar-benar buntu. Memerlukan persetujuan admin.
                      </p>
                    </div>

                    {/* Unlocked Hint Display (hairline callout, no extra box stack) */}
                    {unlockedHintForCurrent && (
                      <div className="py-3 border-b border-[#17231C] space-y-1">
                        <p className="text-xs font-semibold text-[#22FF88] flex items-center gap-1.5">
                          <CheckCircle2 className="w-4 h-4 shrink-0" />
                          <span>Petunjuk Terbuka</span>
                        </p>
                        <p className="text-sm leading-relaxed text-[#E8F3EC] font-medium">
                          {unlockedHintForCurrent.hintText}
                        </p>
                      </div>
                    )}

                    {/* Unlocked Emergency Key Display */}
                    {unlockedEmergencyForCurrent && (
                      <div className="py-3 border-b border-[#17231C] space-y-1.5">
                        <p className="text-xs font-semibold text-[#FFB020] flex items-center gap-1.5">
                          <KeyRound className="w-4 h-4 shrink-0" />
                          <span>Kunci Darurat Diberikan</span>
                        </p>
                        <p className="font-mono text-xl font-bold tracking-widest text-[#FFD07A]">
                          {unlockedEmergencyForCurrent.keyValue}
                        </p>
                      </div>
                    )}

                    <div className="space-y-2.5">
                      <button
                        type="button"
                        disabled={
                          Boolean(unlockedHintForCurrent) ||
                          Boolean(pendingHintReq) ||
                          helpLoading !== null ||
                          sessionDoc?.status === 'ended'
                        }
                        onClick={() => handleRequestHelp('hint')}
                        className="w-full min-h-[48px] px-4 py-2.5 rounded-xl border border-[#1E3126] bg-[#060907] hover:border-[#22FF88]/45 text-sm font-semibold text-[#E8F3EC] flex items-center justify-between gap-2 disabled:opacity-50 cursor-pointer transition-colors"
                      >
                        <span className="inline-flex items-center gap-2">
                          <Lightbulb className="w-4 h-4 text-[#FFB020] shrink-0" />
                          <span>
                            {pendingHintReq
                              ? 'Menunggu admin...'
                              : unlockedHintForCurrent
                                ? 'Petunjuk sudah terbuka'
                                : 'Minta Petunjuk'}
                          </span>
                        </span>
                        <span className="font-mono text-xs text-[#FFB020] tabular-nums">
                          {sessionDoc?.pointsHint ?? -3} poin
                        </span>
                      </button>

                      <button
                        type="button"
                        disabled={
                          Boolean(unlockedEmergencyForCurrent) ||
                          Boolean(pendingEmergencyReq) ||
                          helpLoading !== null ||
                          sessionDoc?.status === 'ended'
                        }
                        onClick={() => handleRequestHelp('emergency')}
                        className="w-full min-h-[48px] px-4 py-2.5 rounded-xl border border-[#1E3126] bg-[#060907] hover:border-[#FF3B5C]/45 text-sm font-semibold text-[#E8F3EC] flex items-center justify-between gap-2 disabled:opacity-50 cursor-pointer transition-colors"
                      >
                        <span className="inline-flex items-center gap-2">
                          <KeyRound className="w-4 h-4 text-[#FF3B5C] shrink-0" />
                          <span>
                            {pendingEmergencyReq
                              ? 'Menunggu admin...'
                              : unlockedEmergencyForCurrent
                                ? 'Kunci darurat aktif'
                                : 'Minta Kunci Darurat'}
                          </span>
                        </span>
                        <span className="font-mono text-xs text-[#FF3B5C] tabular-nums">
                          {sessionDoc?.pointsEmergency ?? -5} poin
                        </span>
                      </button>
                    </div>

                    {(pendingHintReq || pendingEmergencyReq) && (
                      <p className="text-xs font-mono text-[#FFB020]">
                        Status: Menunggu admin menyetujui permintaan...
                      </p>
                    )}
                    {!pendingHintReq && rejectedHintReq && !unlockedHintForCurrent && (
                      <p className="text-xs text-[#FF9BAE]">
                        Permintaan petunjuk ditolak admin.
                      </p>
                    )}
                    {!pendingEmergencyReq &&
                      rejectedEmergencyReq &&
                      !unlockedEmergencyForCurrent && (
                        <p className="text-xs text-[#FF9BAE]">
                          Permintaan kunci darurat ditolak admin.
                        </p>
                      )}
                    {helpMessage && (
                      <p className="text-xs text-[#8AA396]">{helpMessage}</p>
                    )}
                  </section>
                </div>
              </div>
            )}

            {/* Activity History */}
            <section className="rounded-2xl border border-[#1B2A21] bg-[#0B110D] overflow-hidden">
              <div className="px-5 sm:px-6 py-4 border-b border-[#17231C] flex items-center justify-between">
                <h3 className="text-base font-bold text-[#E8F3EC]">
                  Riwayat Aktivitas Kelompok
                </h3>
                <span className="font-mono text-xs text-[#8AA396] tabular-nums">
                  {logs.length} catatan
                </span>
              </div>

              {logs.length === 0 ? (
                <p className="px-5 sm:px-6 py-6 text-sm text-[#8AA396]">
                  Belum ada aktivitas tercatat.
                </p>
              ) : (
                <div className="divide-y divide-[#17231C]">
                  {logs.map((log) => (
                    <div
                      key={log.id}
                      className="px-5 sm:px-6 py-3 flex items-center justify-between gap-4 text-sm"
                    >
                      <div className="min-w-0">
                        <p className="text-[#E8F3EC] font-medium truncate">
                          {log.action}
                        </p>
                        <p className="font-mono text-xs text-[#8AA396]">
                          {formatTimeWib(log.createdAtMs)}
                          {log.reason ? ` · ${log.reason}` : ''}
                        </p>
                      </div>
                      <span
                        className={`font-mono font-bold tabular-nums shrink-0 ${
                          log.delta > 0
                            ? 'text-[#22FF88]'
                            : log.delta < 0
                              ? 'text-[#FF3B5C]'
                              : 'text-[#8AA396]'
                        }`}
                      >
                        {log.delta > 0 ? `+${log.delta}` : log.delta}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* Footer Leave Group */}
            <div className="flex flex-wrap items-center justify-between gap-3 pt-1 text-xs text-[#8AA396]">
              <div className="flex items-center gap-4">
                <Link href="/layar" className="hover:text-[#22FF88] transition-colors whitespace-nowrap shrink-0">
                  Layar Proyektor
                </Link>
                <Link href="/admin" className="hover:text-[#22FF88] transition-colors whitespace-nowrap shrink-0">
                  Panel Admin
                </Link>
              </div>
              {!confirmLeave ? (
                <button
                  type="button"
                  onClick={() => setConfirmLeave(true)}
                  className="inline-flex items-center gap-1.5 text-[#8AA396] hover:text-[#FF3B5C] min-h-[36px] px-2 cursor-pointer transition-colors"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  <span>Ganti Kelompok</span>
                </button>
              ) : (
                <div className="flex items-center gap-2">
                  <span>Keluar dari perangkat ini?</span>
                  <button
                    type="button"
                    onClick={handleLeaveGroup}
                    className="px-2.5 py-1 rounded-md bg-[#FF3B5C] text-white font-semibold cursor-pointer"
                  >
                    Ya
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmLeave(false)}
                    className="px-2.5 py-1 rounded-md border border-[#1E3126] text-[#E8F3EC] cursor-pointer"
                  >
                    Batal
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
