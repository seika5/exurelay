import type { Metadata, Viewport } from "next";
import { IdentityProvider } from "@/context/IdentityContext";
import { CallProvider } from "@/context/CallContext";
import { ServiceWorkerSetup } from "@/components/AppShell";
import { PluginProvider } from "@/context/PluginContext";
import { appPath } from "@/lib/basePath";
import "./globals.css";

export const metadata: Metadata = {
  title: "Relay",
  description: "E2EE messaging and voice/video for a closed circle",
  manifest: appPath("/manifest.webmanifest"),
  icons: { icon: appPath("/icon-192.png"), apple: appPath("/apple-touch-icon.png") },
  appleWebApp: { capable: true, title: "Relay", statusBarStyle: "black-translucent" },
};

export const viewport: Viewport = {
  themeColor: "#0f0f12",
  viewportFit: "cover",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">
        <ServiceWorkerSetup />
        <PluginProvider>
          <IdentityProvider>
            <CallProvider>
              {children}
            </CallProvider>
          </IdentityProvider>
        </PluginProvider>
      </body>
    </html>
  );
}
