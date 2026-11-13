'use client';

let audioCtx: AudioContext | null = null;
let mutedState = false;
let unlockedState = false;

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return null;
  if (!audioCtx) {
    audioCtx = new Ctx();
  }
  return audioCtx;
}

export function isAudioMuted(): boolean {
  return mutedState;
}

export function setAudioMuted(muted: boolean): void {
  mutedState = muted;
  if (muted && typeof window !== 'undefined' && 'speechSynthesis' in window) {
    try {
      window.speechSynthesis.cancel();
    } catch {
      // ignore
    }
  }
}

export function isAudioUnlocked(): boolean {
  return unlockedState;
}

function playTone(
  freq: number,
  startTimeOffset: number,
  duration: number,
  type: OscillatorType = 'triangle',
  volume = 0.22,
  ignoreMute = false
): void {
  if (mutedState && !ignoreMute) return;
  const ctx = getAudioContext();
  if (!ctx) return;
  if (ctx.state === 'suspended') {
    ctx.resume().catch(() => {});
  }

  const now = ctx.currentTime + startTimeOffset;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, now);

  gain.gain.setValueAtTime(0.001, now);
  gain.gain.exponentialRampToValueAtTime(volume, now + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(now);
  osc.stop(now + duration + 0.02);
}

const FEMALE_VOICE_HINTS = [
  'gadis',
  'damayanti',
  'google bahasa indonesia',
  'female',
  'woman',
  'wanita',
  'perempuan',
  'putri',
  'siti',
  'ayu',
  'wati',
  'lestari',
  'cinta',
  'maya',
  'indah',
  'ratna',
  'dewi',
  'nisa',
  'sari',
  'aria',
  'jenny',
  'zira',
  'samantha',
  'karen',
  'victoria',
];

const MALE_VOICE_HINTS = [
  'ardi',
  'andika',
  'rizky',
  'budi',
  'male',
  'man',
  'pria',
  'laki',
  'david',
  'mark',
  'daniel',
  'alex',
];

function pickIndonesianFemaleVoice(voices: SpeechSynthesisVoice[]): {
  voice: SpeechSynthesisVoice | null;
  confirmedFemale: boolean;
} {
  const idVoices = voices.filter(
    (v) =>
      v.lang.toLowerCase().startsWith('id') ||
      v.name.toLowerCase().includes('indonesia')
  );
  if (idVoices.length === 0) {
    const anyFemale = voices.find((v) =>
      FEMALE_VOICE_HINTS.some((kw) => v.name.toLowerCase().includes(kw))
    );
    return { voice: anyFemale || null, confirmedFemale: Boolean(anyFemale) };
  }

  const explicitFemale = idVoices.find((v) =>
    FEMALE_VOICE_HINTS.some((kw) => v.name.toLowerCase().includes(kw))
  );
  if (explicitFemale) {
    return { voice: explicitFemale, confirmedFemale: true };
  }

  const nonMale = idVoices.find(
    (v) => !MALE_VOICE_HINTS.some((kw) => v.name.toLowerCase().includes(kw))
  );
  if (nonMale) {
    return { voice: nonMale, confirmedFemale: false };
  }

  return { voice: idVoices[0], confirmedFemale: false };
}

function speakIndonesian(text: string, ignoreMute = false): void {
  if (
    (mutedState && !ignoreMute) ||
    typeof window === 'undefined' ||
    !('speechSynthesis' in window)
  ) {
    return;
  }
  try {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'id-ID';
    utterance.rate = 1.03;

    const voices = window.speechSynthesis.getVoices();
    const { voice, confirmedFemale } = pickIndonesianFemaleVoice(voices);
    if (voice) {
      utterance.voice = voice;
    }
    // Slightly higher pitch ensures a natural female tone even on fallback voices
    utterance.pitch = confirmedFemale ? 1.08 : 1.24;

    window.speechSynthesis.speak(utterance);
  } catch {
    // ignore speech failures on restricted browsers
  }
}

export async function activateAudioEngine(): Promise<boolean> {
  const ctx = getAudioContext();
  if (ctx && ctx.state === 'suspended') {
    try {
      await ctx.resume();
    } catch {
      // ignore
    }
  }
  unlockedState = true;

  // Play crisp confirmation ping
  if (!mutedState && ctx) {
    playTone(587.33, 0, 0.09, 'sine', 0.18);
    playTone(880, 0.09, 0.15, 'sine', 0.2);
  }

  // Prime Web Speech API gently so voice list (including female voices) is ready
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    try {
      window.speechSynthesis.getVoices();
    } catch {
      // ignore
    }
  }

  return true;
}

export function playCorrectKeySound(): void {
  if (mutedState) return;
  // Ascending victory arpeggio
  playTone(523.25, 0, 0.12, 'triangle', 0.22); // C5
  playTone(659.25, 0.1, 0.12, 'triangle', 0.22); // E5
  playTone(783.99, 0.2, 0.14, 'triangle', 0.24); // G5
  playTone(1046.5, 0.31, 0.28, 'sine', 0.26); // C6

  setTimeout(() => {
    speakIndonesian('Kunci benar!');
  }, 260);
}

export function playWrongKeySound(): void {
  if (mutedState) return;
  const ctx = getAudioContext();
  if (ctx && ctx.state === 'suspended') {
    ctx.resume().catch(() => {});
  }
  if (ctx) {
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(160, now);
    osc.frequency.linearRampToValueAtTime(88, now + 0.42);
    gain.gain.setValueAtTime(0.24, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.45);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.48);
  }

  setTimeout(() => {
    speakIndonesian('Kode salah, coba lagi');
  }, 320);
}

export function playVaultOpenedFanfare(): void {
  if (mutedState) return;
  // Multi-note victory fanfare
  playTone(523.25, 0, 0.14, 'triangle', 0.24);
  playTone(523.25, 0.15, 0.1, 'triangle', 0.22);
  playTone(659.25, 0.27, 0.14, 'triangle', 0.24);
  playTone(783.99, 0.42, 0.18, 'triangle', 0.26);
  playTone(1046.5, 0.62, 0.45, 'sine', 0.28);
  playTone(1318.5, 0.72, 0.45, 'sine', 0.2);

  setTimeout(() => {
    speakIndonesian('Kunci benar! Brankas terbuka!');
  }, 600);
}

export function playProjectorBannerSound(isVault = false): void {
  if (mutedState) return;
  if (isVault) {
    playTone(523.25, 0, 0.12, 'triangle', 0.2);
    playTone(783.99, 0.12, 0.14, 'triangle', 0.22);
    playTone(1046.5, 0.25, 0.35, 'sine', 0.24);
  } else {
    playTone(659.25, 0, 0.1, 'sine', 0.18);
    playTone(987.77, 0.11, 0.2, 'sine', 0.22);
  }
}

export function playAdminCorrectSound(teamName: string, isVault = false): void {
  if (isVault) {
    playTone(523.25, 0, 0.12, 'triangle', 0.22, true);
    playTone(659.25, 0.11, 0.12, 'triangle', 0.22, true);
    playTone(783.99, 0.22, 0.14, 'triangle', 0.24, true);
    playTone(1046.5, 0.34, 0.32, 'sine', 0.26, true);
  } else {
    playTone(659.25, 0, 0.1, 'sine', 0.2, true);
    playTone(880, 0.1, 0.12, 'sine', 0.22, true);
    playTone(1174.66, 0.21, 0.22, 'sine', 0.24, true);
  }

  const safeName = teamName.trim() || 'Kelompok';
  setTimeout(() => {
    speakIndonesian(
      isVault ? `${safeName} membuka brankas!` : `${safeName}, kunci benar!`,
      true
    );
  }, 240);
}

export function playAdminWrongSound(teamName: string): void {
  playTone(220, 0, 0.14, 'sawtooth', 0.18, true);
  playTone(155, 0.16, 0.26, 'sawtooth', 0.2, true);

  const safeName = teamName.trim() || 'Kelompok';
  setTimeout(() => {
    speakIndonesian(`${safeName}, kode salah!`, true);
  }, 260);
}

export function playAdminTimeWarningSound(
  stage: '5m' | '1m' | '30s' | '0s'
): void {
  if (stage === '5m') {
    playTone(587.33, 0, 0.14, 'triangle', 0.22, true);
    playTone(783.99, 0.16, 0.22, 'triangle', 0.22, true);
    setTimeout(() => {
      speakIndonesian('Perhatian! Sisa waktu tinggal lima menit lagi.', true);
    }, 320);
    return;
  }

  if (stage === '1m') {
    playTone(783.99, 0, 0.12, 'triangle', 0.24, true);
    playTone(587.33, 0.14, 0.12, 'triangle', 0.24, true);
    playTone(783.99, 0.28, 0.24, 'triangle', 0.24, true);
    setTimeout(() => {
      speakIndonesian(
        'Perhatian! Waktu hampir habis, tersisa satu menit lagi.',
        true
      );
    }, 420);
    return;
  }

  if (stage === '30s') {
    playTone(880, 0, 0.1, 'sine', 0.24, true);
    playTone(880, 0.15, 0.1, 'sine', 0.24, true);
    playTone(880, 0.3, 0.2, 'sine', 0.24, true);
    setTimeout(() => {
      speakIndonesian('Perhatian! Tiga puluh detik terakhir.', true);
    }, 420);
    return;
  }

  // stage === '0s'
  playTone(440, 0, 0.2, 'sawtooth', 0.22, true);
  playTone(329.63, 0.22, 0.2, 'sawtooth', 0.22, true);
  playTone(261.63, 0.44, 0.42, 'sawtooth', 0.22, true);
  setTimeout(() => {
    speakIndonesian('Waktu sesi telah habis!', true);
  }, 560);
}
