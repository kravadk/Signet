import Link from "next/link";

export function Header() {
  return (
    <header className="site-header">
      <div className="wrap">
        <Link href="/" className="brand">
          <span className="spark" />
          WalrusForge
        </Link>
        <span className="net-badge">sui testnet · walrus</span>
      </div>
    </header>
  );
}

export function Footer() {
  return (
    <footer className="site-footer">
      <div className="wrap">
        <span>WalrusForge — agent-native release network on Sui + Walrus</span>
        <span>verifiable provenance · built for Sui Overflow 2026</span>
      </div>
    </footer>
  );
}

export function Chip({
  label,
  href,
  icon = "↗",
}: {
  label: string;
  href?: string;
  icon?: string;
}) {
  const inner = (
    <>
      <span>{label}</span>
      {href && <span className="ico">{icon}</span>}
    </>
  );
  if (href) {
    return (
      <a className="chip" href={href} target="_blank" rel="noreferrer">
        {inner}
      </a>
    );
  }
  return <span className="chip">{inner}</span>;
}
