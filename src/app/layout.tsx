import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";

import { ThemePicker } from "@/components/theme-picker";
import { THEME_INIT_SCRIPT } from "@/lib/theme";

import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: { default: "feature-bridge-agent", template: "%s | feature-bridge-agent" },
  description: "Request a feature, review an AI-generated plan, and preview the result.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // data-theme is set before hydration by the init script, so the server and
    // client markup legitimately differ on <html>.
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        {/* Runs during HTML parsing, before first paint, so the saved theme never
            flashes. next/script's beforeInteractive only queues it for later. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="min-h-dvh antialiased">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-primary-foreground"
        >
          Skip to content
        </a>
        <header className="border-b border-border">
          <div className="mx-auto flex max-w-3xl items-center justify-between gap-4 px-4 py-3">
            <Link href="/" className="font-semibold">
              feature-bridge-agent
            </Link>
            <ThemePicker />
          </div>
        </header>
        <main id="main" tabIndex={-1} className="mx-auto max-w-3xl px-4 py-12 focus:outline-none">
          {children}
        </main>
      </body>
    </html>
  );
}
