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

const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ||
  "https://institutonovamedida.com.br";

export const metadata: Metadata = {
  title: {
    default:
      "Instituto Nova Medida — Avaliação médica online para emagrecimento",
    template: "%s · Instituto Nova Medida",
  },
  description:
    "Instituto Nova Medida. Não é sobre força de vontade — é sobre o método certo. Avaliação médica online, individual e sem compromisso. Você só segue se fizer sentido.",
  metadataBase: new URL(SITE_URL),
  applicationName: "Instituto Nova Medida",
  openGraph: {
    title:
      "Instituto Nova Medida — Avaliação médica online para emagrecimento",
    description:
      "Avaliação médica online, individual e sem compromisso. Você só segue se fizer sentido.",
    locale: "pt_BR",
    type: "website",
    siteName: "Instituto Nova Medida",
    url: SITE_URL,
  },
  twitter: {
    card: "summary_large_image",
    title:
      "Instituto Nova Medida — Avaliação médica online para emagrecimento",
    description:
      "Avaliação médica online, individual e sem compromisso. Você só segue se fizer sentido.",
  },
  robots: { index: true, follow: true },
  authors: [{ name: "Instituto Nova Medida" }],
  formatDetection: { telephone: false },
  category: "health",
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
