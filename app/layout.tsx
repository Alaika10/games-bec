import type { Metadata } from 'next';
import {
  Bricolage_Grotesque,
  Plus_Jakarta_Sans,
  JetBrains_Mono,
} from 'next/font/google';
import './globals.css';

const bricolage = Bricolage_Grotesque({
  subsets: ['latin'],
  weight: ['600', '700', '800'],
  variable: '--font-display',
  display: 'swap',
});

const jakarta = Plus_Jakarta_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-sans',
  display: 'swap',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'HACK THE SYSTEM: Reading Escape Room',
  description:
    'Aplikasi lomba membaca bahasa Inggris berkelompok bergaya terminal dengan papan skor real-time, tampilan proyektor, dan kontrol admin.',
  openGraph: {
    title: 'HACK THE SYSTEM: Reading Escape Room',
    description:
      'Aplikasi lomba membaca bahasa Inggris berkelompok bergaya terminal dengan papan skor real-time, tampilan proyektor, dan kontrol admin.',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'HACK THE SYSTEM: Reading Escape Room',
    description:
      'Aplikasi lomba membaca bahasa Inggris berkelompok bergaya terminal dengan papan skor real-time, tampilan proyektor, dan kontrol admin.',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="id"
      className={`${bricolage.variable} ${jakarta.variable} ${jetbrainsMono.variable}`}
    >
      <body
        suppressHydrationWarning
        className="min-h-screen bg-[#070A08] text-[#E8F3EC] font-sans antialiased selection:bg-[#22FF88]/25 selection:text-[#22FF88]"
      >
        {children}
      </body>
    </html>
  );
}
