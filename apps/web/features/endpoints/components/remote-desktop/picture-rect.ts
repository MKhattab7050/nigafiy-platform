/**
 * Where the remote picture is drawn inside the canvas element. In full screen the canvas fills the
 * screen and shows the picture with `object-fit: contain`, so black bars may sit on two sides; a
 * pointer position must be measured against the picture, not the element (else taps land off).
 * Outside full screen the element is exactly the picture and this returns its box unchanged.
 */
export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function pictureBox(element: Box, pictureWidth: number, pictureHeight: number): Box {
  if (pictureWidth <= 0 || pictureHeight <= 0 || element.width <= 0 || element.height <= 0) return element;
  const scale = Math.min(element.width / pictureWidth, element.height / pictureHeight);
  const width = pictureWidth * scale;
  const height = pictureHeight * scale;
  return { left: element.left + (element.width - width) / 2, top: element.top + (element.height - height) / 2, width, height };
}

/** The picture's box on screen for a canvas. */
export function canvasPictureBox(canvas: HTMLCanvasElement): Box {
  return pictureBox(canvas.getBoundingClientRect(), canvas.width, canvas.height);
}

/** Natural pixel dimensions of a remote screen element (canvas or direct WebRTC video). */
export function mediaPictureSize(el: HTMLCanvasElement | HTMLVideoElement): { width: number; height: number } {
  return 'videoWidth' in el ? { width: el.videoWidth, height: el.videoHeight } : { width: el.width, height: el.height };
}

/** The picture's box on screen for either a canvas (JPEG / WS H.264) or a WebRTC video element. */
export function mediaPictureBox(el: HTMLCanvasElement | HTMLVideoElement): Box {
  const { width, height } = mediaPictureSize(el);
  return pictureBox(el.getBoundingClientRect(), width, height);
}
