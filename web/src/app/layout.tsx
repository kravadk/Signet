import type { Metadata } from "next";
import "./globals.css";
import { Header, Footer } from "@/components/Chrome";

export const metadata: Metadata = {
  title: "WalrusForge — verifiable releases on Sui + Walrus",
  description:
    "Agent-native repositories, pull requests and verifiable release chains, stored on Walrus and anchored by Sui.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Header />
        <main>{children}</main>
        <Footer />
      </body>
    </html>
  );
}
