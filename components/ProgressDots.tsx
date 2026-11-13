'use client';

interface ProgressDotsProps {
  completed: number;
  total?: number;
  size?: 'sm' | 'lg';
}

export function ProgressDots({
  completed,
  total = 5,
  size = 'sm',
}: ProgressDotsProps) {
  const dotSize = size === 'lg' ? 'w-4 h-4 sm:w-5 sm:h-5' : 'w-3 h-3';
  const gapSize = size === 'lg' ? 'gap-2.5 sm:gap-3' : 'gap-1.5';

  return (
    <div
      className={`inline-flex items-center ${gapSize}`}
      aria-label={`Kemajuan ${completed} dari ${total}`}
    >
      {Array.from({ length: total }).map((_, idx) => {
        const done = idx < completed;
        return (
          <span
            key={idx}
            className={`${dotSize} rounded-full transition-colors duration-200 ${
              done
                ? 'bg-[#22FF88] shadow-[0_0_10px_rgba(34,255,136,0.65)]'
                : 'bg-[#122018] border border-[#243B2E]'
            }`}
          />
        );
      })}
    </div>
  );
}
