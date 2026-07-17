import { Bell, HardDrive, Router, Server, Wifi } from "lucide-react";
import type { HubStats, LocalVideo } from "../types";

export function StatDeck({ stats }: { stats: HubStats | null }) {
  const cards = [
    { label: "资源站", value: stats ? `${stats.enabledSites}/${stats.sites}` : "--", icon: <Server size={20} />, tone: "teal" },
    { label: "追剧", value: stats?.watchlist ?? "--", icon: <Bell size={20} />, tone: "accent" },
    { label: "本地库", value: stats?.library ?? "--", icon: <HardDrive size={20} />, tone: "gold" }
  ];

  return (
    <div className="stat-deck">
      {cards.map((card) => (
        <article className={`stat-card ${card.tone}`} key={card.label}>
          {card.icon}
          <span>{card.label}</span>
          <strong>{card.value}</strong>
        </article>
      ))}
    </div>
  );
}

export function ServerCard({ stats, library }: { stats: HubStats | null; library: LocalVideo[] }) {
  const appUrls = stats?.serverUrls ?? ["http://localhost:5173"];
  const apiUrls = stats?.apiUrls ?? ["http://localhost:8787"];

  return (
    <section className="panel">
      <div className="panel-title">
        <div>
          <p className="eyebrow">Remote Server</p>
          <h3>局域网影院</h3>
        </div>
        <Router size={20} />
      </div>
      <div className="lan-list">
        {appUrls.slice(0, 3).map((url) => (
          <a href={url} key={url}>
            <Wifi size={15} />
            {url}
          </a>
        ))}
      </div>
      <div className="api-list">
        {apiUrls.slice(0, 2).map((url) => (
          <span key={url}>
            <Server size={13} />
            {url}
          </span>
        ))}
      </div>
      <p className="soft-line">{library.length} 个本地视频</p>
    </section>
  );
}
