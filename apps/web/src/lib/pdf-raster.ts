// Cap the longest bitmap edge and total bitmap area while preserving the
// on-screen dimensions. Large-format PDF pages can exceed browser canvas limits.
export function rasterScale(width: number, height: number, deviceRatio: number): number {
  const desired = Math.min(Math.max(deviceRatio || 1, 1), 2);
  return Math.min(desired, 4096 / Math.max(width, height), Math.sqrt(16_000_000 / (width * height)));
}

export function pageMillimetres(widthPoints: number, heightPoints: number): { width: number; height: number } {
  return { width: Math.round(widthPoints * 25.4 / 72), height: Math.round(heightPoints * 25.4 / 72) };
}
