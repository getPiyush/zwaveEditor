/** Formats seconds as m:ss.mmm, or h:mm:ss.mmm past an hour. */
export function formatTime(seconds: number, decimals = 3): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  const secsText = secs.toFixed(decimals).padStart(decimals > 0 ? decimals + 3 : 2, "0");

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${secsText}`;
  }
  return `${minutes}:${secsText}`;
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, exp);
  return `${value.toFixed(exp === 0 ? 0 : 1)} ${units[exp]}`;
}

export function formatSampleRate(rate: number): string {
  return `${(rate / 1000).toFixed(rate % 1000 === 0 ? 0 : 1)} kHz`;
}

export function channelLayoutName(count: number): string {
  if (count === 1) return "Mono";
  if (count === 2) return "Stereo";
  return `${count} channels`;
}

export function channelLabel(index: number, count: number): string {
  if (count === 1) return "M";
  if (count === 2) return index === 0 ? "L" : "R";
  return String(index + 1);
}
