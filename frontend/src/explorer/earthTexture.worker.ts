/// <reference lib="webworker" />
import { drawEarth, type EarthColors } from './earthDraw';

// Rasterises and PNG-encodes the Earth texture off the main thread: at 8192 px the encode alone
// would otherwise stall the page for a noticeable moment while the globe is starting.

self.onmessage = async (e: MessageEvent<{ width: number; colors: EarthColors }>) => {
  try {
    const { width, colors } = e.data;
    const canvas = new OffscreenCanvas(width, width / 2);
    await drawEarth(canvas.getContext('2d')!, width, colors);
    self.postMessage(await canvas.convertToBlob({ type: 'image/png' }));
  } catch (err) {
    self.postMessage(String((err as Error)?.message ?? err));
  }
};
