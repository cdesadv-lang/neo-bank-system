import type { Metadata } from "next";
import "./globals.css";
import { getLang } from "@/server/page-auth";

export const metadata: Metadata = {
  title: "Neo Bank — نيو بنك",
  description: "Core banking + digital banking (demo, fictional data)",
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const lang = await getLang();
  return (
    <html lang={lang} dir={lang === "ar" ? "rtl" : "ltr"}>
      <body className="min-h-screen bg-slate-50 text-slate-900 antialiased">{children}</body>
    </html>
  );
}
