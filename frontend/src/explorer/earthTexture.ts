import { drawEarth, type EarthColors } from './earthDraw';

export type { EarthColors };

function drawInWorker(width: number, colors: EarthColors): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./earthTexture.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<Blob | string>) => {
      worker.terminate();
      if (typeof e.data === 'string') reject(new Error(e.data));
      else resolve(e.data);
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message));
    };
    worker.postMessage({ width, colors });
  });
}

async function drawOnMainThread(width: number, colors: EarthColors): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = width / 2;
  await drawEarth(canvas.getContext('2d')!, width, colors);
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('could not encode the Earth texture'))), 'image/png'),
  );
}

/** Draws the Earth texture (off the main thread where OffscreenCanvas exists) and returns an object URL for it. */
export async function buildEarthTexture(width: number, colors: EarthColors): Promise<string> {
  let blob: Blob;
  try {
    if (typeof OffscreenCanvas === 'undefined') throw new Error('no OffscreenCanvas');
    blob = await drawInWorker(width, colors);
  } catch {
    blob = await drawOnMainThread(width, colors);
  }
  return URL.createObjectURL(blob);
}
