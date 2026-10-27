export function liveWatchRefreshInterval(samplesPerSecond = 4, uiInterval = 200): number {
    const samples = Number.isFinite(samplesPerSecond) ? Math.max(1, Math.min(20, samplesPerSecond)) : 4;
    const ui = Number.isFinite(uiInterval) ? Math.max(200, Math.min(5000, uiInterval)) : 300;
    return Math.max(ui, 1000 / samples);
}
