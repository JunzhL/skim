import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Skill Manager",
  description: "Manage shared agent skills safely.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
