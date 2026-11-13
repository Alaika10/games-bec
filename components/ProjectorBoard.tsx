'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence, LayoutGroup } from 'motion/react';
import { collection, doc, onSnapshot } from 'firebase/firestore';
import Link from 'next/link';
import { Trophy, Volume2, VolumeX, Award, LogOut } from 'lucide-react';
import { db, handleFirestoreError, OperationType, testFirestoreConnection } from '@/lib/firebase';
import { computeRemainingSeconds, formatClock, rankGroups } from '@/lib/game-utils';
import {
  activateAudioEngine,
  isAudioMuted,
  isAudioUnlocked,
  playProjectorBannerSound,
  setAudioMuted,
} from '@/lib/sound';
import { GroupDoc, SessionDoc } from '@/lib/types';
import { ProgressDots } from './ProgressDots';
import { AnimatedNumber } from './AnimatedNumber';

export function ProjectorBoard({ initialCode }: { initialCode?: string }) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionDoc, setSessionDoc] = useState<SessionDoc | null>(null);
  const [groups, setGroups] = useState<GroupDoc[]>([]);
  const [serverOffsetMs, setServerOffsetMs] = useState(0);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [audioReady, setAudioReady] = useState(() => isAudioUnlocked());
  const [muted, setMuted] = useState(() => isAudioMuted());
  const [banner, setBanner] = useState<{
    id: string;
    message: string;
    isVault: boolean;
  } | null>(null);

  const lastSeenEventIdRef = useRef<string>('');

  useEffect(() => {
    testFirestoreConnection().catch(() => {});

    let active = true;
    (async () => {
      try {
        const url = initialCode
          ? `/api/session/bootstrap?code=${encodeURIComponent(initialCode)}`
          : '/api/session/bootstrap';
        const res = await fetch(url);
        if (!res.ok) return;
        const data = await res.json();
        if (active && data.sessionId) {
          setSessionId(data.sessionId);
          if (data.serverNowMs) {
            setServerOffsetMs(data.serverNowMs - Date.now());
          }
        }
      } catch {
        // ignore
      }
    })();

    return () => {
      active = false;
    };
  }, [initialCode]);

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 250);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!sessionId) return;

    const unsubSession = onSnapshot(
      doc(db, 'sessions', sessionId),
      (snap) => {
        if (!snap.exists()) return;
        const data = { id: snap.id, ...(snap.data() as Omit<SessionDoc, 'id'>) };
        setSessionDoc(data);

        if (
          data.lastEventId &&
          data.lastEventId !== lastSeenEventIdRef.current &&
          (data.lastEventType === 'unlock' || data.lastEventType === 'vault')
        ) {
          const isInitialLoad = lastSeenEventIdRef.current === '';
          lastSeenEventIdRef.current = data.lastEventId;
          // Only trigger toast/chime on real updates after mount or recent event (< 8s)
          const isRecent = Date.now() + serverOffsetMs - data.lastEventAtMs < 8000;
          if (!isInitialLoad || isRecent) {
            const isVault = data.lastEventType === 'vault';
            setBanner({
              id: data.lastEventId,
              message: data.lastEventMessage,
              isVault,
            });
            playProjectorBannerSound(isVault);
            setTimeout(() => {
              setBanner((curr) => (curr?.id === data.lastEventId ? null : curr));
            }, 5200);
          }
        } else if (data.lastEventId && !lastSeenEventIdRef.current) {
          lastSeenEventIdRef.current = data.lastEventId;
        }
      },
      (err) => handleFirestoreError(err, OperationType.GET, `sessions/${sessionId}`)
    );

    const unsubGroups = onSnapshot(
      collection(db, 'sessions', sessionId, 'groups'),
      (snap) => {
        const list: GroupDoc[] = snap.docs.map((d) => ({
          id: d.id,
          ...(d.data() as Omit<GroupDoc, 'id'>),
        }));
        setGroups(list);
      },
      (err) =>
        handleFirestoreError(err, OperationType.LIST, `sessions/${sessionId}/groups`)
    );

    return () => {
      unsubSession();
      unsubGroups();
    };
  }, [sessionId, serverOffsetMs]);

  const ranked = useMemo(() => rankGroups(groups), [groups]);
  const remainingSec = sessionDoc
    ? computeRemainingSeconds(sessionDoc, nowMs + serverOffsetMs)
    : 0;

  const statusText = useMemo(() => {
    if (!sessionDoc) return 'Memuat...';
    if (sessionDoc.status === 'waiting') return 'Menunggu Mulai';
    if (sessionDoc.status === 'running') return 'Berlangsung';
    if (sessionDoc.status === 'paused') return 'Dijeda';
    return 'Selesai';
  }, [sessionDoc]);

  const timerColor =
    sessionDoc?.status === 'ended' || remainingSec <= 60
      ? 'text-[#FF3B5C]'
      : remainingSec <= 300
        ? 'text-[#FFB020]'
        : 'text-[#22FF88]';

  const handleAudioToggle = async () => {
    if (!audioReady) {
      await activateAudioEngine();
      setAudioReady(true);
      setAudioMuted(false);
      setMuted(false);
    } else {
      const next = !muted;
      setAudioMuted(next);
      setMuted(next);
    }
  };

  const topThree = ranked.slice(0, 3);
  const restTeams = ranked.slice(3);

  return (
    <div className="min-h-screen flex flex-col px-6 lg:px-12 py-6 lg:py-8 max-w-[1440px] mx-auto">
      {/* Projector Header */}
      <header className="flex flex-col lg:flex-row lg:items-center justify-between gap-6 pb-6 border-b border-[#1A2D22]">
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-3 font-mono text-sm text-[#8AA899]">
            <span>READING ESCAPE ROOM</span>
            {sessionDoc && (
              <>
                <span aria-hidden="true">·</span>
                <span>KODE SESI: <strong className="text-[#22FF88]">{sessionDoc.sessionCode}</strong></span>
                <span aria-hidden="true">·</span>
                <span>{statusText}</span>
              </>
            )}
          </div>
          <h1 className="text-3xl sm:text-4xl lg:text-5xl font-extrabold tracking-tight text-[#E6F4EC] text-balance">
            {sessionDoc?.title || 'HACK THE SYSTEM: Reading Escape Room'}
          </h1>
        </div>

        <div className="flex flex-wrap items-center justify-between lg:justify-end gap-4 sm:gap-6 shrink-0">
          <div className="text-left lg:text-right">
            <p className="font-mono text-xs tracking-[0.2em] text-[#8AA899]">
              HITUNG MUNDUR SESI
            </p>
            <p className={`font-mono text-5xl sm:text-6xl lg:text-7xl font-extrabold tabular-nums tracking-tight ${timerColor}`}>
              {sessionDoc ? formatClock(remainingSec) : '--:--'}
            </p>
          </div>

          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={handleAudioToggle}
              aria-label={muted ? 'Aktifkan suara proyektor' : 'Bisukan suara proyektor'}
              className={`min-h-[44px] min-w-[44px] px-3.5 rounded-xl border font-mono text-xs font-semibold inline-flex items-center gap-2 whitespace-nowrap shrink-0 transition-colors cursor-pointer ${
                !audioReady || muted
                  ? 'border-[#243B2E] bg-[#0B120E] text-[#8AA899] hover:text-[#22FF88]'
                  : 'border-[#22FF88]/40 bg-[#0D1F15] text-[#22FF88]'
              }`}
            >
              {!audioReady || muted ? (
                <VolumeX className="w-4 h-4 shrink-0" />
              ) : (
                <Volume2 className="w-4 h-4 shrink-0" />
              )}
              <span className="hidden sm:inline">
                {!audioReady ? 'Aktifkan Audio' : muted ? 'Bisu' : 'Audio Aktif'}
              </span>
            </button>

            <Link
              href="/"
              aria-label="Keluar dan kembali ke beranda"
              title="Keluar dan kembali ke beranda"
              className="min-h-[44px] px-3.5 rounded-xl border border-[#243B2E] bg-[#0B120E] text-[#8AA899] hover:text-[#22FF88] hover:border-[#22FF88]/40 font-mono text-xs font-semibold inline-flex items-center gap-2 whitespace-nowrap shrink-0 transition-colors"
            >
              <LogOut className="w-4 h-4 shrink-0" />
              <span>Beranda</span>
            </Link>
          </div>
        </div>
      </header>

      {/* Animated Event Banner */}
      <AnimatePresence>
        {banner && (
          <motion.div
            key={banner.id}
            initial={{ opacity: 0, y: -18, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -12, scale: 0.98 }}
            transition={{ duration: 0.25 }}
            className={`mt-6 rounded-2xl border-2 px-6 py-5 text-center shadow-[0_0_40px_rgba(34,255,136,0.22)] ${
              banner.isVault
                ? 'border-[#FFB020] bg-[#1F1708] text-[#FFD07A]'
                : 'border-[#22FF88] bg-[#0B2214] text-[#22FF88]'
            }`}
          >
            <p className="font-mono text-2xl sm:text-4xl font-extrabold tracking-wider">
              {banner.message}
            </p>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Main Content: Podium on Ended OR Live Leaderboard */}
      <main className="flex-1 pt-8">
        {sessionDoc?.status === 'ended' ? (
          /* PODIUM 3 BESAR */
          <div className="space-y-10">
            <div className="text-center space-y-2">
              <p className="font-mono text-sm tracking-[0.22em] text-[#22FF88]">
                SESI BERAKHIR · HASIL RESMI
              </p>
              <h2 className="text-3xl sm:text-5xl font-extrabold text-[#E6F4EC]">
                Podium 3 Besar
              </h2>
            </div>

            {topThree.length === 0 ? (
              <p className="text-center text-lg text-[#8AA899]">
                Belum ada kelompok terdaftar pada sesi ini.
              </p>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6 items-end max-w-5xl mx-auto">
                {/* 2nd Place (left on desktop) */}
                {topThree[1] && (
                  <div className="order-2 md:order-1 rounded-2xl border border-[#8AA899]/50 bg-[#0B120E] p-6 text-center space-y-4 md:min-h-[260px] flex flex-col justify-between">
                    <div className="space-y-2">
                      <div className="w-12 h-12 rounded-full bg-[#192820] text-[#D2E3DA] font-mono text-xl font-bold flex items-center justify-center mx-auto">
                        #2
                      </div>
                      <p className="font-mono text-xs tracking-widest text-[#8AA899]">
                        JUARA 2
                      </p>
                      <h3 className="text-2xl font-bold text-[#E6F4EC]">
                        {topThree[1].teamName}
                      </h3>
                      <p className="text-sm text-[#8AA899]">
                        {topThree[1].members.join(', ')}
                      </p>
                    </div>
                    <div className="space-y-2 pt-3 border-t border-[#18291F]">
                      <div className="flex justify-center">
                        <ProgressDots
                          completed={topThree[1].completedSheets}
                          total={sessionDoc.totalSheets}
                          size="lg"
                        />
                      </div>
                      <p className="font-mono text-3xl font-extrabold text-[#E6F4EC] tabular-nums">
                        {topThree[1].points} poin
                      </p>
                    </div>
                  </div>
                )}

                {/* 1st Place (center tallest) */}
                {topThree[0] && (
                  <div className="order-1 md:order-2 rounded-2xl border-2 border-[#22FF88] bg-[#0B1B12] p-7 text-center space-y-5 md:min-h-[320px] flex flex-col justify-between shadow-[0_0_48px_rgba(34,255,136,0.16)]">
                    <div className="space-y-2">
                      <div className="w-14 h-14 rounded-full bg-[#22FF88] text-[#041209] flex items-center justify-center mx-auto">
                        <Trophy className="w-7 h-7" />
                      </div>
                      <p className="font-mono text-xs tracking-widest text-[#22FF88]">
                        JUARA 1
                      </p>
                      <h3 className="text-3xl font-extrabold text-[#E6F4EC]">
                        {topThree[0].teamName}
                      </h3>
                      <p className="text-sm text-[#B7D6C4]">
                        {topThree[0].members.join(', ')}
                      </p>
                    </div>
                    <div className="space-y-2.5 pt-4 border-t border-[#1D3828]">
                      <div className="flex justify-center">
                        <ProgressDots
                          completed={topThree[0].completedSheets}
                          total={sessionDoc.totalSheets}
                          size="lg"
                        />
                      </div>
                      <p className="font-mono text-4xl font-extrabold text-[#22FF88] tabular-nums">
                        {topThree[0].points} poin
                      </p>
                    </div>
                  </div>
                )}

                {/* 3rd Place (right on desktop) */}
                {topThree[2] && (
                  <div className="order-3 rounded-2xl border border-[#FFB020]/50 bg-[#0B120E] p-6 text-center space-y-4 md:min-h-[230px] flex flex-col justify-between">
                    <div className="space-y-2">
                      <div className="w-12 h-12 rounded-full bg-[#211A0E] text-[#FFB020] font-mono text-xl font-bold flex items-center justify-center mx-auto">
                        <Award className="w-6 h-6" />
                      </div>
                      <p className="font-mono text-xs tracking-widest text-[#FFB020]">
                        JUARA 3
                      </p>
                      <h3 className="text-2xl font-bold text-[#E6F4EC]">
                        {topThree[2].teamName}
                      </h3>
                      <p className="text-sm text-[#8AA899]">
                        {topThree[2].members.join(', ')}
                      </p>
                    </div>
                    <div className="space-y-2 pt-3 border-t border-[#18291F]">
                      <div className="flex justify-center">
                        <ProgressDots
                          completed={topThree[2].completedSheets}
                          total={sessionDoc.totalSheets}
                          size="lg"
                        />
                      </div>
                      <p className="font-mono text-3xl font-extrabold text-[#E6F4EC] tabular-nums">
                        {topThree[2].points} poin
                      </p>
                    </div>
                  </div>
                )}
              </div>
            )}

            {restTeams.length > 0 && (
              <div className="max-w-4xl mx-auto rounded-2xl border border-[#1B2F23] bg-[#0B120E] p-6 space-y-3">
                <h3 className="font-mono text-xs tracking-widest text-[#8AA899]">
                  PERINGKAT LAINNYA
                </h3>
                <div className="divide-y divide-[#17281E]">
                  {restTeams.map((g, i) => (
                    <div
                      key={g.id}
                      className="py-3 flex items-center justify-between gap-4"
                    >
                      <div className="flex items-center gap-4 min-w-0">
                        <span className="font-mono text-lg font-bold text-[#8AA899] w-10 tabular-nums">
                          #{i + 4}
                        </span>
                        <span className="text-lg font-semibold text-[#E6F4EC] truncate">
                          {g.teamName}
                        </span>
                      </div>
                      <div className="flex items-center gap-6 shrink-0">
                        <ProgressDots
                          completed={g.completedSheets}
                          total={sessionDoc.totalSheets}
                        />
                        <span className="font-mono text-xl font-bold text-[#E6F4EC] tabular-nums w-24 text-right">
                          {g.points} pts
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          /* LIVE REAL-TIME SCOREBOARD */
          <div className="space-y-5">
            <div className="flex items-center justify-between">
              <h2 className="text-xl sm:text-2xl font-bold text-[#E6F4EC]">
                Papan Skor Langsung
              </h2>
              <span className="font-mono text-sm text-[#8AA899]">
                {ranked.length} Kelompok Terdaftar
              </span>
            </div>

            {ranked.length === 0 ? (
              <div className="rounded-2xl border border-[#1B2F23] bg-[#0B120E] p-12 text-center space-y-2">
                <p className="text-xl font-semibold text-[#E6F4EC]">
                  Belum ada kelompok yang bergabung
                </p>
                <p className="text-base text-[#8AA899]">
                  Peserta dapat mendaftar menggunakan Kode Sesi{' '}
                  <strong className="font-mono text-[#22FF88]">
                    {sessionDoc?.sessionCode || '----'}
                  </strong>
                </p>
              </div>
            ) : (
              <LayoutGroup>
                <div className="space-y-3">
                  {/* Column Headers */}
                  <div className="hidden sm:grid grid-cols-12 gap-4 px-6 py-2 font-mono text-xs tracking-wider text-[#8AA899]">
                    <div className="col-span-2">PERINGKAT</div>
                    <div className="col-span-5">KELOMPOK</div>
                    <div className="col-span-3 text-center">KEMAJUAN</div>
                    <div className="col-span-2 text-right">POIN</div>
                  </div>

                  {ranked.map((group, idx) => {
                    const isLeader = idx === 0 && group.points > 0;
                    return (
                      <motion.div
                        key={group.id}
                        layout
                        transition={{
                          type: 'spring',
                          stiffness: 320,
                          damping: 28,
                        }}
                        className={`rounded-xl border px-5 sm:px-6 py-4 sm:py-5 grid grid-cols-12 items-center gap-4 ${
                          isLeader
                            ? 'border-[#22FF88]/70 bg-[#0B1B12] shadow-[0_0_24px_rgba(34,255,136,0.1)]'
                            : 'border-[#1B2F23] bg-[#0B120E]'
                        }`}
                      >
                        <div className="col-span-2 flex items-center gap-3">
                          <span
                            className={`font-mono text-2xl sm:text-3xl font-extrabold tabular-nums ${
                              idx === 0
                                ? 'text-[#22FF88]'
                                : idx === 1
                                  ? 'text-[#D2E3DA]'
                                  : idx === 2
                                    ? 'text-[#FFB020]'
                                    : 'text-[#8AA899]'
                            }`}
                          >
                            #{idx + 1}
                          </span>
                        </div>

                        <div className="col-span-6 sm:col-span-5 min-w-0">
                          <p className="text-lg sm:text-2xl font-bold text-[#E6F4EC] truncate">
                            {group.teamName}
                          </p>
                          <p className="text-xs sm:text-sm text-[#8AA899] truncate">
                            {group.members.join(' · ')}
                          </p>
                        </div>

                        <div className="hidden sm:flex col-span-3 justify-center">
                          <ProgressDots
                            completed={group.completedSheets}
                            total={sessionDoc?.totalSheets ?? 5}
                            size="lg"
                          />
                        </div>

                        <div className="col-span-4 sm:col-span-2 text-right">
                          <p
                            className={`font-mono text-2xl sm:text-4xl font-extrabold tabular-nums ${
                              isLeader ? 'text-[#22FF88]' : 'text-[#E6F4EC]'
                            }`}
                          >
                            <AnimatedNumber value={group.points} />
                          </p>
                          <div className="sm:hidden mt-1.5 flex justify-end">
                            <ProgressDots
                              completed={group.completedSheets}
                              total={sessionDoc?.totalSheets ?? 5}
                            />
                          </div>
                        </div>
                      </motion.div>
                    );
                  })}
                </div>
              </LayoutGroup>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
