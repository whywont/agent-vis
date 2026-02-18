import type { Metadata } from "next";
import "../../public/style.css";
import "@xterm/xterm/css/xterm.css";

export const metadata: Metadata = {
  title: "agent-vis",
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
