/**
 * Responsive Font Size Auto-Adjuster & Screen Display Scaler
 * Prevents headings and text from crossing margins or breaking layouts across any display
 * with pixel-crisp font rendering (no subpixel blur).
 */

export interface AutoAdjustOptions {
  minFontSize?: number; // minimum font size in px (e.g. 11)
  maxFontSize?: number; // maximum font size in px
  step?: number;        // reduction step in px (default 0.5)
  parentPadding?: number; // safety padding in px (default 4)
}

/**
 * Dynamically adjusts an element's font size until it fits completely within its parent's width.
 * Prevents horizontal overflow, crossing margins, or breaking layout boundaries.
 */
export function autoAdjustFontSize(
  element: HTMLElement | null,
  options: AutoAdjustOptions = {}
): number | null {
  if (!element) return null;

  const minFontSize = options.minFontSize ?? 11;
  const step = options.step ?? 0.5;
  const parent = element.parentElement;
  if (!parent) return null;

  // Save original styles if not already saved
  if (!element.dataset.originalFontSize) {
    const computed = window.getComputedStyle(element);
    element.dataset.originalFontSize = computed.fontSize;
  }

  // Start with max allowed size or the original computed size
  let currentSize = options.maxFontSize ?? parseFloat(element.dataset.originalFontSize || '18');
  element.style.fontSize = `${currentSize}px`;
  element.style.whiteSpace = 'nowrap';
  element.style.overflow = 'hidden';
  element.style.textOverflow = 'ellipsis';
  element.style.maxWidth = '100%';

  const safetyPadding = options.parentPadding ?? 4;
  const maxAllowedWidth = Math.max(20, parent.clientWidth - safetyPadding);

  // Iteratively reduce font size until scrollWidth <= maxAllowedWidth or minFontSize reached
  while (element.scrollWidth > maxAllowedWidth && currentSize > minFontSize) {
    currentSize -= step;
    element.style.fontSize = `${Math.round(currentSize * 2) / 2}px`;
  }

  return currentSize;
}

export type DisplayScaleMode = 'auto' | 'compact' | 'standard' | 'large';
export type FontTheme = 'jost';

/**
 * Applies the Jost font theme cleanly to CSS variables and document root.
 */
export function applyFontTheme(_theme?: FontTheme): void {
  localStorage.setItem('crm_font_theme', 'jost');
  document.documentElement.style.setProperty(
    '--font-main',
    "'Jost', sans-serif"
  );
  document.documentElement.style.fontFamily = "'Jost', sans-serif";
  if (document.body) {
    document.body.style.fontFamily = "'Jost', sans-serif";
  }
}

/**
 * Calculates display scale multiplier based on window innerWidth.
 */
export function calculateDisplayScale(): number {
  const width = window.innerWidth;
  if (width < 640) {
    return 0.9;
  } else if (width < 1024) {
    return 0.94;
  } else if (width < 1280) {
    return 0.97;
  } else if (width <= 1536) {
    return 1.0;
  } else {
    return 1.04;
  }
}

/**
 * Applies display scale factor to the document root and CSS variables
 * with pixel-crisp, non-fractional rounded rem values to completely prevent font blur.
 */
export function applyDisplayScale(mode?: DisplayScaleMode): void {
  const activeMode: DisplayScaleMode =
    mode || (localStorage.getItem('crm_display_scale_mode') as DisplayScaleMode) || 'auto';

  let multiplier = 1.0;
  if (activeMode === 'auto') {
    multiplier = calculateDisplayScale();
  } else if (activeMode === 'compact') {
    multiplier = 0.9;
  } else if (activeMode === 'standard') {
    multiplier = 1.0;
  } else if (activeMode === 'large') {
    multiplier = 1.1;
  }

  document.documentElement.style.setProperty('--display-scale', multiplier.toString());

  // Crisp, non-fractional clamped rem values preventing subpixel rasterization blur
  const h1 = (1.45 * multiplier).toFixed(2);
  const h2 = (1.22 * multiplier).toFixed(2);
  const h3 = (1.02 * multiplier).toFixed(2);
  const h4 = (0.88 * multiplier).toFixed(2);

  document.documentElement.style.setProperty('--h1-size', `${h1}rem`);
  document.documentElement.style.setProperty('--h2-size', `${h2}rem`);
  document.documentElement.style.setProperty('--h3-size', `${h3}rem`);
  document.documentElement.style.setProperty('--h4-size', `${h4}rem`);

  applyFontTheme();

  // Auto-fit any elements with .auto-fit-text
  const autoFitElements = document.querySelectorAll<HTMLElement>('.auto-fit-text');
  autoFitElements.forEach((el) => autoAdjustFontSize(el));
}

/**
 * Initializes the global screen display font scaler listener.
 */
export function initGlobalFontAutoScaler(): () => void {
  applyDisplayScale();
  applyFontTheme();

  const handleResize = () => {
    applyDisplayScale();
  };

  window.addEventListener('resize', handleResize);
  (window as unknown as { autoAdjustFontSize: typeof autoAdjustFontSize }).autoAdjustFontSize = autoAdjustFontSize;
  (window as unknown as { applyDisplayScale: typeof applyDisplayScale }).applyDisplayScale = applyDisplayScale;
  (window as unknown as { applyFontTheme: typeof applyFontTheme }).applyFontTheme = applyFontTheme;

  return () => {
    window.removeEventListener('resize', handleResize);
  };
}
