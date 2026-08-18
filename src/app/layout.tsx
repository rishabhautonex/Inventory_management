import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";

import { THEME_STORAGE_KEY } from "@/lib/theme";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "LabStock",
  description: "R&D lab inventory — what we have, where it is, who took it.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Zoom stays available; the app just does not start zoomed.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#0b0f14" },
    { media: "(prefers-color-scheme: dark)", color: "#0b0f14" },
  ],
};

/**
 * Applies the stored theme before the first paint.
 *
 * Dark is the base, so this only ever has to act for someone who chose light —
 * but it has to act before the browser paints, which rules out doing it in an
 * effect. Kept to one statement and wrapped in try/catch because localStorage
 * throws outright in some privacy modes.
 */
const themeScript = `try{var t=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)});if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="font-sans flex min-h-full flex-col">{children}</body>
    </html>
  );
}
