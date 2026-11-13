'use client';

import { useEffect, useState } from 'react';

interface TypewriterCodeProps {
  code: string;
  label?: string;
}

export function TypewriterCode({
  code,
  label = 'CARI LEMBAR BERKODE:',
}: TypewriterCodeProps) {
  const [revealState, setRevealState] = useState<{ target: string; count: number }>({
    target: code,
    count: code.length,
  });

  useEffect(() => {
    const prefersReduced =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (prefersReduced) {
      const id = setTimeout(() => {
        setRevealState({ target: code, count: code.length });
      }, 0);
      return () => clearTimeout(id);
    }

    let index = 0;
    const interval = setInterval(() => {
      index += 1;
      setRevealState({ target: code, count: index });
      if (index >= code.length) {
        clearInterval(interval);
      }
    }, 65);

    return () => clearInterval(interval);
  }, [code]);

  const displayed =
    revealState.target === code ? code.slice(0, revealState.count) : '';

  return (
    <div className="space-y-2 text-center">
      <p className="font-mono text-xs sm:text-sm tracking-[0.18em] text-[#8AA899]">
        {label}
      </p>
      <div className="inline-flex items-center justify-center px-6 py-4 rounded-xl bg-[#040705] border border-[#22FF88]/40 shadow-[0_0_28px_rgba(34,255,136,0.12)]">
        <span className="font-mono text-4xl sm:text-5xl font-bold tracking-[0.14em] text-[#22FF88] animate-subtle-glitch tabular-nums">
          {displayed}
          <span className="inline-block w-[3px] h-9 sm:h-11 bg-[#22FF88] ml-1.5 align-middle animate-pulse" />
        </span>
      </div>
    </div>
  );
}
