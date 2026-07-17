import { Star } from "lucide-react";
import type { CatalogItem } from "../types";
import { imageUrlFor, kindText } from "../lib/format";

type PosterCardProps = {
  item: CatalogItem;
  onOpen: (item: CatalogItem) => void;
};

export function PosterCard({ item, onOpen }: PosterCardProps) {
  return (
    <button className="poster-card" type="button" onClick={() => onOpen(item)}>
      <span className="poster-frame">
        {item.poster ? <img src={imageUrlFor(item.poster)} alt={item.title} loading="lazy" /> : <span className="poster-fallback">{item.title}</span>}
        {item.score && (
          <span className="score-badge">
            <Star size={12} />
            {item.score}
          </span>
        )}
      </span>
      <span className="poster-copy">
        <strong>{item.title}</strong>
        <small>{item.year ?? item.remarks ?? kindText(item.kind)}</small>
      </span>
    </button>
  );
}
