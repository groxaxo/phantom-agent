/**
 * Screenshot capture via CDP.
 * Uses Page.captureScreenshot for viewport and full-page captures.
 */
import type { CDPSession } from '../browser/session.js';
import { logger } from '../utils/logger.js';

export interface ScreenshotOptions {
  format?: 'png' | 'jpeg' | 'webp';
  quality?: number;
  fullPage?: boolean;
  clip?: { x: number; y: number; width: number; height: number; scale?: number };
}

export async function captureScreenshot(
  session: CDPSession,
  options: ScreenshotOptions = {},
): Promise<string> {
  const { format = 'jpeg', quality = 75, fullPage = false, clip } = options;

  const params: Record<string, unknown> = {
    format,
    quality: format === 'png' ? undefined : quality,
    captureBeyondViewport: fullPage,
    optimizeForSpeed: true,
  };

  if (fullPage) {
    // Get full page dimensions
    const metrics = await session.send<{
      contentSize: { width: number; height: number };
    }>('Page.getLayoutMetrics');
    const { width, height } = metrics.contentSize;
    params.clip = { x: 0, y: 0, width, height, scale: 1 };
  } else if (clip) {
    params.clip = { ...clip, scale: clip.scale ?? 1 };
  }

  const result = await session.send<{ data: string }>('Page.captureScreenshot', params);
  logger.debug('Screenshot', `Captured ${format} screenshot (${result.data.length} bytes base64)`);
  return result.data;
}

/**
 * Capture an element screenshot by bounding box.
 */
export async function captureElementScreenshot(
  session: CDPSession,
  selector: string,
): Promise<string | null> {
  try {
    // Get element bounding box via DOM
    const { root } = await session.send<{ root: { nodeId: number } }>('DOM.getDocument');
    const { nodeId } = await session.send<{ nodeId: number }>('DOM.querySelector', {
      nodeId: root.nodeId,
      selector,
    });
    if (!nodeId) return null;

    const { model } = await session.send<{
      model: { content: number[] };
    }>('DOM.getBoxModel', { nodeId });

    const content = model.content;
    const x = Math.min(content[0], content[2], content[4], content[6]);
    const y = Math.min(content[1], content[3], content[5], content[7]);
    const width = Math.max(content[0], content[2], content[4], content[6]) - x;
    const height = Math.max(content[1], content[3], content[5], content[7]) - y;

    return captureScreenshot(session, {
      clip: { x, y, width, height },
    });
  } catch (e) {
    logger.warn('Screenshot', `Element capture failed: ${(e as Error).message}`);
    return null;
  }
}
