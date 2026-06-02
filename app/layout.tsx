export const metadata = {
  title: 'HIVEMIND Chat',
  description: 'Multi-model chat via OpenRouter',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, padding: 0, background: '#0d1117' }}>{children}</body>
    </html>
  );
}
