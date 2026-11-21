import type { Metadata } from "next";
import { Exo_2, Poppins } from "next/font/google";
import { Providers } from "@/components/Providers";
import "./globals.css";

const poppins = Poppins({ variable: "--font-poppins", subsets: ["latin"], weight: ["300", "400", "500", "600"] });
const exo = Exo_2({ variable: "--font-exo", subsets: ["latin"], weight: ["500", "600"] });

export const metadata: Metadata = {
  title: { default: "Sigmaflux Mail", template: "%s · Sigmaflux Mail" },
  description: "Multi-tenant cold email platform — mailboxes, warmup, sequences, campaigns and lead finding.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${poppins.variable} ${exo.variable}`}>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
