import type { Metadata, Viewport } from "next";
import { Fraunces, Manrope } from "next/font/google";
import { BottomNav, SideNav } from "@/components/nav";
import "./globals.css";

const fraunces = Fraunces({
  variable: "--font-fraunces",
  subsets: ["latin"],
  weight: ["500", "600"],
});

const manrope = Manrope({
  variable: "--font-manrope",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Health Maxxing",
  description: "A personal health and weight-loss tracker.",
};

export const viewport: Viewport = {
  themeColor: "#131110",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${fraunces.variable} ${manrope.variable} h-full antialiased`}
    >
      <body className="min-h-full">
        <div className="mx-auto flex min-h-full max-w-6xl md:px-4">
          <SideNav />
          <main className="min-w-0 flex-1 px-4 pb-24 pt-6 md:px-8 md:pb-10 md:pt-8">
            {children}
          </main>
        </div>
        <BottomNav />
      </body>
    </html>
  );
}
