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
  const pipSize =
    size === 'lg' ? 'w-5 h-2.5 sm:w-6 sm:h-3' : 'w-3.5 h-2';
  const gapSize = size === 'lg' ? 'gap-2 sm:gap-2.5' : 'gap-1.5';

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
            className={`${pipSize} rounded-[3px] transition-colors duration-200 ${
              done
                ? 'bg-[#22FF88] shadow-[0_0_8px_rgba(34,255,136,0.45)]'
                : 'bg-[#101914] border border-[#26382E]'
            }`}
          />
        );
      })}
    </div>
  );
}
