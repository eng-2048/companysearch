import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Company Search — 2048 Ventures",
  description: "Gather all internal context on a company or founder into one bundle.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
