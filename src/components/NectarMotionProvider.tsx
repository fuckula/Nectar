import type { ReactNode } from "react";
import { MotionConfig } from "framer-motion";
import { useSurfaceMetrics } from "../hooks/useSurfaceMetrics";

export function NectarMotionProvider({ children }: { children: ReactNode }) {
  const { motionSpeed } = useSurfaceMetrics();
  return (
    <MotionConfig reducedMotion={motionSpeed <= 0 ? "always" : "user"}>
      {children}
    </MotionConfig>
  );
}
