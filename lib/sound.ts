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
  volume = 0.22
): void {
  if (mutedState) return;
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

function speakIndonesian(text: string): void {
  if (mutedState || typeof window === 'undefined' || !('speechSynthesis' in window)) return;
  try {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'id-ID';
    utterance.rate = 1.05;
    utterance.pitch = 1.0;
    const voices = window.speechSynthesis.getVoices();
    const idVoice = voices.find((v) => v.lang.toLowerCase().startsWith('id'));
    if (idVoice) {
      utterance.voice = idVoice;
    }
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

  // Prime Web Speech API gently
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
