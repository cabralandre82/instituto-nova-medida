import type { Metadata, Viewport } from "next";
import { Inter, Fraunces } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const fraunces = Fraunces({
  subsets: ["latin"],
  variable: "--font-fraunces",
  display: "swap",
  axes: ["opsz", "SOFT"],
});

export const metadata: Metadata = {
  title: "Instituto Nova Medida — Avaliação médica online para emagrecimento",
  description:
    "Instituto Nova Medida. Não é sobre força de vontade — é sobre o método certo. Avaliação médica online, individual e sem compromisso. Você só segue se fizer sentido.",
  metadataBase: new URL("https://institutonovamedida.com.br"),
  openGraph: {
    title: "Instituto Nova Medida — Avaliação médica online para emagrecimento",
    description:
      "Avaliação médica online, individual e sem compromisso. Você só segue se fizer sentido.",
    locale: "pt_BR",
    type: "website",
    siteName: "Instituto Nova Medida",
    url: "https://institutonovamedida.com.br",
  },
  robots: { index: true, follow: true },
  authors: [{ name: "Instituto Nova Medida" }],
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  themeColor: "#FAF7F2",
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="pt-BR" className={`${inter.variable} ${fraunces.variable}`}>
      <body className="bg-cream-100 text-ink-800 font-sans antialiased">
        {children}
      </body>
    </html>
  );
}
