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
    <div className="space-y-3 text-center">
      <p className="font-mono text-xs sm:text-sm tracking-[0.2em] text-[#8AA396]">
        {label}
      </p>
      <div className="relative inline-flex items-center justify-center px-8 py-5 rounded-xl bg-[#040705] border border-[#22FF88]/35 cipher-grid-subtle overflow-hidden">
        {/* Precision architectural corner brackets */}
        <span
          aria-hidden="true"
          className="absolute top-2 left-2 w-2.5 h-2.5 border-t border-l border-[#22FF88]/70"
        />
        <span
          aria-hidden="true"
          className="absolute top-2 right-2 w-2.5 h-2.5 border-t border-r border-[#22FF88]/70"
        />
        <span
          aria-hidden="true"
          className="absolute bottom-2 left-2 w-2.5 h-2.5 border-b border-l border-[#22FF88]/70"
        />
        <span
          aria-hidden="true"
          className="absolute bottom-2 right-2 w-2.5 h-2.5 border-b border-r border-[#22FF88]/70"
        />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 terminal-scanlines opacity-50"
        />
        <span className="relative font-mono text-4xl sm:text-5xl font-bold tracking-[0.16em] text-[#22FF88] animate-subtle-glitch tabular-nums">
          {displayed}
          <span
            aria-hidden="true"
            className="inline-block w-[3px] h-9 sm:h-11 bg-[#22FF88] ml-1.5 align-middle animate-caret-blink"
          />
        </span>
      </div>
    </div>
  );
}
