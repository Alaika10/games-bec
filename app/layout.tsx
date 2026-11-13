import type { Metadata } from 'next';
import { Outfit, JetBrains_Mono } from 'next/font/google';
import './globals.css';

const outfit = Outfit({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  variable: '--font-outfit',
  display: 'swap',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-jetbrains-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'HACK THE SYSTEM: Reading Escape Room',
  description:
    'Aplikasi lomba membaca bahasa Inggris berkelompok bergaya terminal hacker dengan papan skor real-time, tampilan proyektor, dan kontrol admin.',
  openGraph: {
    title: 'HACK THE SYSTEM: Reading Escape Room',
    description:
      'Aplikasi lomba membaca bahasa Inggris berkelompok bergaya terminal hacker dengan papan skor real-time, tampilan proyektor, dan kontrol admin.',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'HACK THE SYSTEM: Reading Escape Room',
    description:
      'Aplikasi lomba membaca bahasa Inggris berkelompok bergaya terminal hacker dengan papan skor real-time, tampilan proyektor, dan kontrol admin.',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="id" className={`${outfit.variable} ${jetbrainsMono.variable}`}>
      <body
        suppressHydrationWarning
        className="min-h-screen bg-[#060A08] text-[#E6F4EC] font-sans antialiased selection:bg-[#22FF88]/30 selection:text-[#22FF88]"
      >
        {children}
      </body>
    </html>
  );
}
