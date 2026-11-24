import { useLayoutEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { useSurfaceMetrics } from "../hooks/useSurfaceMetrics";

export type SurfaceEdge = "top" | "bottom" | "left" | "right";

interface Props {
  edge: SurfaceEdge;
  // Radius of the concave flares where the surface meets the screen edge, 0 when it has none
  flare: number;
  // Radius of the corners that point away from the screen edge
  radius: number;
  // Radius of the corners on the screen-edge side when there is no flare (a floating surface)
  edgeRadius?: number;
  // Clamp bounds passed to scaledRadius (raw unscaled base radii should be supplied)
  minRadius?: number;
  maxRadius?: number;
  // Drawn inside the fill layer, so it is clipped to the same silhouette, flares included
  children?: ReactNode;
  // Hides the outline while the surface is still growing, so it cannot trail the fill
  settling?: boolean;
}

const INSET = 0.5;

// The surface's whole silhouette, flares included, as one path. It is both the clip of the fill
// layer (glass, texture, wallpaper) and the line drawn around it, so the flares can never differ
// from the body. Coordinates are the surface's own box; (ox, oy) shifts them into the fill layer,
// which reaches `flare` px past the box on the flare sides.
function silhouette(edge: SurfaceEdge, w: number, h: number, f: number, r: number, er: number, i: number, ox: number, oy: number): { d: string; closed: boolean } {
  const X = (x: number) => x + ox;
  const Y = (y: number) => y + oy;
  const P = (x: number, y: number) => `${X(x)} ${Y(y)}`;
  const arc = (rad: number, sweep: number, x: number, y: number) => `A ${rad} ${rad} 0 0 ${sweep} ${P(x, y)}`;
  const clamp = (v: number, max: number) => Math.max(0, Math.min(v, max));

  if (edge === "top") {
    const rr = clamp(r, Math.min(w / 2, h));
    const a = Math.max(0, rr - i);
    if (f > 0) {
      return { closed: false, d: `M ${P(-f, 0)} ${arc(f, 1, i, f)} V ${Y(h - rr)} ${arc(a, 0, rr, h - i)} H ${X(w - rr)} ${arc(a, 0, w - i, h - rr)} V ${Y(f)} ${arc(f, 1, w + f, 0)}` };
    }
    const te = clamp(er, Math.min(w / 2, h));
    const ta = Math.max(0, te - i);
    return { closed: true, d: `M ${P(i, h - rr)} V ${Y(te)} ${arc(ta, 1, te, i)} H ${X(w - te)} ${arc(ta, 1, w - i, te)} V ${Y(h - rr)} ${arc(a, 1, w - rr, h - i)} H ${X(rr)} ${arc(a, 1, i, h - rr)} Z` };
  }

  if (edge === "bottom") {
    const rr = clamp(r, Math.min(w / 2, h));
    const a = Math.max(0, rr - i);
    if (f > 0) {
      return { closed: false, d: `M ${P(-f, h)} ${arc(f, 0, i, h - f)} V ${Y(rr)} ${arc(a, 1, rr, i)} H ${X(w - rr)} ${arc(a, 1, w - i, rr)} V ${Y(h - f)} ${arc(f, 0, w + f, h)}` };
    }
    const be = clamp(er, Math.min(w / 2, h));
    if (be > 0) {
      const ba = Math.max(0, be - i);
      return { closed: true, d: `M ${P(i, h - be)} V ${Y(rr)} ${arc(a, 1, rr, i)} H ${X(w - rr)} ${arc(a, 1, w - i, rr)} V ${Y(h - be)} ${arc(ba, 1, w - be, h - i)} H ${X(be)} ${arc(ba, 1, i, h - be)} Z` };
    }
    return { closed: false, d: `M ${P(i, h)} V ${Y(rr)} ${arc(a, 1, rr, i)} H ${X(w - rr)} ${arc(a, 1, w - i, rr)} V ${Y(h)}` };
  }

  const rr = clamp(r, Math.min(w, h / 2));
  const a = Math.max(0, rr - i);
  if (edge === "left") {
    return { closed: false, d: `M ${P(0, -f)} ${arc(f, 0, f, i)} H ${X(w - rr)} ${arc(a, 1, w - i, rr)} V ${Y(h - rr)} ${arc(a, 1, w - rr, h - i)} H ${X(f)} ${arc(f, 0, 0, h + f)}` };
  }
  return { closed: false, d: `M ${P(w, -f)} ${arc(f, 1, w - f, i)} H ${X(rr)} ${arc(a, 0, i, rr)} V ${Y(h - rr)} ${arc(a, 0, rr, h - i)} H ${X(w - f)} ${arc(f, 1, w, h + f)}` };
}

export function SurfaceShape({
  edge,
  flare,
  radius,
  edgeRadius = 0,
  minRadius = 12,
  maxRadius = 36,
  children,
  settling = false,
}: Props) {
  const { scaledRadius } = useSurfaceMetrics();
  const effectiveRadius = radius > 0 ? scaledRadius(radius, minRadius, maxRadius) : 0;
  const effectiveEdgeRadius = edgeRadius > 0 ? scaledRadius(edgeRadius, minRadius, maxRadius) : 0;

  const svgRef = useRef<SVGSVGElement>(null);
  const fillRef = useRef<HTMLDivElement>(null);
  const pathRef = useRef<SVGPathElement>(null);

  const horizontal = edge === "top" || edge === "bottom";
  const ox = horizontal ? flare : 0;
  const oy = horizontal ? 0 : flare;

  useLayoutEffect(() => {
    const svg = svgRef.current;
    const fillEl = fillRef.current;
    const pathEl = pathRef.current;
    if (!svg || !fillEl || !pathEl) return;

    let lastW = -1;
    let lastH = -1;

    const apply = (force = false) => {
      const w = svg.clientWidth;
      const h = svg.clientHeight;
      if (!force && w === lastW && h === lastH) return;
      lastW = w;
      lastH = h;
      if (w <= 0 || h <= 0) {
        fillEl.style.clipPath = "inset(0 0 100% 0)";
        pathEl.setAttribute("d", "");
        return;
      }
      const fill = silhouette(edge, w, h, flare, effectiveRadius, effectiveEdgeRadius, 0, ox, oy);
      const line = silhouette(edge, w, h, flare, effectiveRadius, effectiveEdgeRadius, INSET, 0, 0);
      fillEl.style.clipPath = `path('${fill.d}${fill.closed ? "" : " Z"}')`;
      pathEl.setAttribute("d", line.d);
    };

    apply(true);
    const observer = new ResizeObserver(() => apply(false));
    observer.observe(svg);
    return () => observer.disconnect();
  }, [edge, flare, effectiveRadius, effectiveEdgeRadius, ox, oy]);

  const fillStyle: CSSProperties = {
    left: horizontal ? -flare : 0,
    right: horizontal ? -flare : 0,
    top: horizontal ? 0 : -flare,
    bottom: horizontal ? 0 : -flare,
    clipPath: "inset(0 0 100% 0)",
  };

  return (
    <>
      <div ref={fillRef} className="surface-fill" style={fillStyle} aria-hidden="true">{children}</div>
      <svg ref={svgRef} className={`edge-outline${settling ? " settling" : ""}`} aria-hidden>
        <path ref={pathRef} d="" />
      </svg>
    </>
  );
}
