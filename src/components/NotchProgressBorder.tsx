import { useLayoutEffect, useRef } from "react";
import { useSurfaceMetrics } from "../hooks/useSurfaceMetrics";

interface Props {
  progress: number;
  topRadius: number;
  flare: number;
  bottomRadius: number;
  paused: boolean;
  finished: boolean;
  title?: string;
}

const STROKE = 2;

export function NotchProgressBorder({ progress, topRadius, flare, bottomRadius, paused, finished, title }: Props) {
  const { scaledRadius } = useSurfaceMetrics();
  const effectiveTopRadius = topRadius > 0 ? scaledRadius(topRadius, 12, 36) : 0;
  const effectiveBottomRadius = bottomRadius > 0 ? scaledRadius(bottomRadius, 12, 36) : 0;

  const svgRef = useRef<SVGSVGElement>(null);
  const trackRef = useRef<SVGPathElement>(null);
  const fillRef = useRef<SVGPathElement>(null);

  useLayoutEffect(() => {
    const el = svgRef.current;
    const track = trackRef.current;
    const fill = fillRef.current;
    if (!el || !track || !fill) return;

    let lastW = -1;
    let lastH = -1;

    const apply = (force = false) => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (!force && w === lastW && h === lastH) return;
      lastW = w;
      lastH = h;
      if (w <= 0 || h <= 0) {
        track.setAttribute("d", "");
        fill.setAttribute("d", "");
        return;
      }
      const inset = STROKE / 2;
      const scale = Math.min(1, w / (2 * effectiveBottomRadius || 1), h / (effectiveTopRadius + effectiveBottomRadius || 1));
      const rb = effectiveBottomRadius * scale;
      const rt = effectiveTopRadius * scale;
      const arc = Math.max(0, rb - inset);
      const sides = flare > 0 ? flare : rt;
      const start = flare > 0 ? `M ${-flare} 0 A ${flare} ${flare} 0 0 1 ${inset} ${flare}` : `M ${inset} ${rt}`;
      const end = flare > 0 ? ` A ${flare} ${flare} 0 0 1 ${w + flare} 0` : "";
      const path = `${start} V ${h - rb} A ${arc} ${arc} 0 0 0 ${rb} ${h - inset} H ${w - rb} A ${arc} ${arc} 0 0 0 ${w - inset} ${h - rb} V ${sides}${end}`;
      track.setAttribute("d", path);
      fill.setAttribute("d", path);
    };

    apply(true);
    const observer = new ResizeObserver(() => apply(false));
    observer.observe(el);
    return () => observer.disconnect();
  }, [effectiveTopRadius, effectiveBottomRadius, flare]);

  return (
    <svg ref={svgRef} className={`notch-progress${paused ? " paused" : ""}${finished ? " finished" : ""}`} aria-hidden>
      {title && <title>{title}</title>}
      <path ref={trackRef} d="" className="notch-progress-track" />
      <path
        ref={fillRef}
        d=""
        className="notch-progress-fill"
        pathLength={100}
        strokeDasharray={`${Math.max(0, Math.min(100, progress))} 100`}
      />
    </svg>
  );
}
