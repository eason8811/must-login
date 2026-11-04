/** A keyframe after array/property-indexed normalization. */
interface NormalizedKeyframe {
  /** Animated CSS color value. */
  color: unknown;
  /** Animated CSS transform value. */
  transform: unknown;
  /** Easing function to the next keyframe. */
  easing: string;
  /** Normalized position in the animation, between 0 and 1. */
  offset: number;
}

/** Supported CSS animation properties supplied to the sampling bridge. */
interface InputKeyframe {
  /** Animated CSS color value. */
  color?: unknown;
  /** Animated CSS transform value. */
  transform?: unknown;
  /** Easing to the next keyframe. */
  easing?: unknown;
  /** Explicit keyframe offset. */
  offset?: unknown;
  /** Computed keyframe offset, when present. */
  computedOffset?: unknown;
}

/** Sample of color and rotation at a specific animation time. */
interface AnimationSample {
  /** Current animation time in milliseconds. */
  currentTime: number;
  /** Animation duration in milliseconds. */
  duration: number;
  /** Un-eased progress between 0 and 1. */
  progress: number;
  /** Progress after easing. */
  easedProgress: number;
  /** Interpolated CSS rgb() color. */
  color: string;
  /** Interpolated CSS matrix() rotation. */
  transform: string;
}

/** Optional diagnostics emitted by the CSS animation adapter. */
export interface AnimationBridgeEvents {
  /** Called when an element starts an animation. */
  onCreate?: (details: { element: string | null; keyframes: NormalizedKeyframe[] | null }) => void;
  /** Called after a supported computed-style sample. */
  onSample?: (details: AnimationSample) => void;
  /** Called when keyframes or animation timing cannot be represented. */
  onUnsupported?: (details: { element: string | null; reason: string }) => void;
}

/** The subset of a browser window needed for animation interception. */
export interface AnimationWindow {
  /** DOM Element constructor for the emulated window. */
  Element: { prototype: Element };
  /** Original CSS computed-style method for the emulated window. */
  getComputedStyle: (element: Element, pseudoElement?: string | null) => CSSStyleDeclaration;
}

/**
 * Convert an arbitrary value into a finite number.
 * @param value - Value to convert with Number().
 * @returns Finite number, or null if conversion fails.
 */
function finiteNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * Linearly interpolate between two numeric endpoints.
 * @param start - Starting numeric value.
 * @param end - Ending numeric value.
 * @param progress - Interpolation fraction.
 * @returns Interpolated numeric value.
 */
function interpolate(start: number, end: number, progress: number): number {
  return start + (end - start) * progress;
}

/**
 * Evaluate one dimension of a cubic Bézier curve at a parameter value.
 * @param t - Parametric location within the curve.
 * @param p1 - First control point coordinate.
 * @param p2 - Second control point coordinate.
 * @returns The coordinate along the chosen dimension.
 */
function cubicBezierCoordinate(t: number, p1: number, p2: number): number {
  const inverse = 1 - t;
  return 3 * inverse * inverse * t * p1 + 3 * inverse * t * t * p2 + t * t * t;
}

/**
 * Evaluate CSS `linear` or `cubic-bezier()` easing.
 *
 * @param easing - CSS easing expression.
 * @param progress - Progress in the interval [0, 1].
 * @returns The eased progress, or null for an unsupported expression.
 */
export function evaluateEasing(easing: string, progress: number): number | null {
  if (!Number.isFinite(progress)) return null;
  if (progress <= 0) return 0;
  if (progress >= 1) return 1;
  const name = String(easing || 'linear').trim().toLowerCase();
  if (name === 'linear') return progress;
  const match = /^cubic-bezier\(\s*([+-]?(?:\d+\.?\d*|\.\d+))\s*,\s*([+-]?(?:\d+\.?\d*|\.\d+))\s*,\s*([+-]?(?:\d+\.?\d*|\.\d+))\s*,\s*([+-]?(?:\d+\.?\d*|\.\d+))\s*\)$/i.exec(name);
  if (!match) return null;
  const [, x1, y1, x2, y2] = match.slice(1).map(Number);
  if ([x1, y1, x2, y2].some(value => !Number.isFinite(value)) || x1! < 0 || x1! > 1 || x2! < 0 || x2! > 1) return null;
  let low = 0;
  let high = 1;
  for (let index = 0; index < 60; index++) {
    const mid = (low + high) / 2;
    if (cubicBezierCoordinate(mid, x1!, x2!) < progress) low = mid;
    else high = mid;
  }
  return cubicBezierCoordinate((low + high) / 2, y1!, y2!);
}

/**
 * Expand array or property-indexed Web Animations keyframes into an array.
 * @param input - Original keyframes passed to Element.animate().
 * @returns A copied array of keyframe properties.
 */
function expandIndexedKeyframes(input: unknown): InputKeyframe[] {
  if (Array.isArray(input)) return input.map(value => ({ ...(value as InputKeyframe) }));
  if (!input || typeof input !== 'object') return [];
  const values = input as Record<string, unknown>;
  const colors = Array.isArray(values.color) ? values.color : [values.color];
  const transforms = Array.isArray(values.transform) ? values.transform : [values.transform];
  const length = Math.max(colors.length, transforms.length);
  if (length < 2) return [];
  const result: InputKeyframe[] = [];
  for (let index = 0; index < length; index++) {
    result.push({
      color: colors[index] ?? colors.at(-1),
      transform: transforms[index] ?? transforms.at(-1),
      easing: Array.isArray(values.easing) ? values.easing[index] ?? 'linear' : values.easing ?? 'linear',
      offset: Array.isArray(values.offset) ? values.offset[index] : undefined,
    });
  }
  return result;
}

/**
 * Normalize keyframes and infer missing interior offsets.
 *
 * @param input - Array or property-indexed keyframes passed to `Element.animate`.
 * @returns Normalized frames, or null if the offsets are invalid.
 */
export function normalizeKeyframes(input: unknown): NormalizedKeyframe[] | null {
  const frames = expandIndexedKeyframes(input);
  if (frames.length < 2) return null;
  const offsets: Array<number | null> = frames.map((frame, index) => {
    const given = frame.computedOffset ?? frame.offset;
    if (given === null || given === undefined) {
      if (index === 0) return 0;
      if (index === frames.length - 1) return 1;
      return null;
    }
    const value = finiteNumber(given);
    return value !== null && value >= 0 && value <= 1 ? value : Number.NaN;
  });
  if (offsets.some(value => Number.isNaN(value))) return null;
  for (let start = 0; start < offsets.length - 1;) {
    let end = start + 1;
    while (end < offsets.length && offsets[end] === null) end++;
    const startOffset = offsets[start];
    const endOffset = offsets[end];
    if (typeof startOffset !== 'number' || typeof endOffset !== 'number' || endOffset < startOffset) return null;
    for (let cursor = start + 1; cursor < end; cursor++) {
      offsets[cursor] = interpolate(startOffset, endOffset, (cursor - start) / (end - start));
    }
    start = end;
  }
  return frames.map((frame, index) => ({
    color: frame.color,
    transform: frame.transform,
    easing: typeof frame.easing === 'string' ? frame.easing : 'linear',
    offset: offsets[index] as number,
  }));
}

/**
 * Parse supported CSS hex or rgb() colors into numeric RGB channels.
 * @param input - CSS color value to parse.
 * @returns Three RGB channels, or null for an unsupported color.
 */
function parseColor(input: unknown): [number, number, number] | null {
  const value = String(input ?? '').trim();
  let digits = /^#([0-9a-f]{6})$/i.exec(value)?.[1];
  if (digits) {
    const fullHex = digits;
    return [0, 2, 4].map(index => Number.parseInt(fullHex.slice(index, index + 2), 16)) as [number, number, number];
  }
  digits = /^#([0-9a-f]{3})$/i.exec(value)?.[1];
  if (digits !== undefined) {
    const shorthandHex = digits;
    return [...shorthandHex].map(char => Number.parseInt(char + char, 16)) as [number, number, number];
  }
  const rgb = /^rgb\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*\)$/i.exec(value);
  if (!rgb) return null;
  const values = rgb.slice(1).map(Number);
  return values.every(channel => channel >= 0 && channel <= 255) ? values as [number, number, number] : null;
}

/**
 * Parse a CSS rotate() expression expressed in degrees.
 * @param input - CSS transform property value.
 * @returns Rotation angle in degrees, or null if unsupported.
 */
function parseRotate(input: unknown): number | null {
  const match = /^rotate\(\s*([+-]?(?:\d+\.?\d*|\.\d+))deg\s*\)$/i.exec(String(input ?? '').trim());
  return match ? finiteNumber(match[1]) : null;
}

/**
 * Convert a rotation angle into CSS matrix() notation.
 * @param angle - Rotation in degrees.
 * @returns Six-component CSS transformation matrix string.
 */
function formatMatrix(angle: number): string {
  const radians = angle * Math.PI / 180;
  const clean = (value: number): number => Number(value.toFixed(6)) || 0;
  const cosine = clean(Math.cos(radians));
  const sine = clean(Math.sin(radians));
  return `matrix(${cosine}, ${sine}, ${clean(-Math.sin(radians))}, ${cosine}, 0, 0)`;
}

/**
 * Sample the subset of WAAPI used by the SDK (color and rotation).
 *
 * @param details - Keyframes, timing configuration, and animation time.
 * @returns A computed color/transform sample, or null if unsupported.
 */
export function sampleAnimationAtTime(details: {
  keyframes: unknown;
  timing: unknown;
  currentTime: unknown;
}): AnimationSample | null {
  const frames = normalizeKeyframes(details.keyframes);
  const timing = details.timing as Record<string, unknown> | number | null;
  const settings: Record<string, unknown> = typeof timing === 'number' ? {} : timing ?? {};
  const duration = finiteNumber(typeof timing === 'number' ? timing : settings.duration);
  const time = finiteNumber(details.currentTime);
  if (!frames || duration === null || duration <= 0 || time === null) return null;
  const delay = finiteNumber(settings.delay ?? 0);
  const iterations = finiteNumber(settings.iterations ?? 1);
  if (delay === null || iterations !== 1 || (settings.direction && settings.direction !== 'normal')) return null;
  const active = (time - delay) / duration;
  const fill = settings.fill ?? 'auto';
  if ((active < 0 && fill !== 'backwards' && fill !== 'both') ||
      (active > 1 && fill !== 'forwards' && fill !== 'both')) return null;
  const progress = Math.max(0, Math.min(1, active));
  const globalProgress = evaluateEasing(String(settings.easing ?? 'linear'), progress);
  if (globalProgress === null) return null;
  let index = frames.length - 2;
  for (let cursor = 0; cursor < frames.length - 1; cursor++) {
    if (globalProgress <= frames[cursor + 1]!.offset) {
      index = cursor;
      break;
    }
  }
  const start = frames[index]!;
  const end = frames[index + 1]!;
  const span = end.offset - start.offset;
  const localProgress = span === 0 ? 1 : (globalProgress - start.offset) / span;
  const easedProgress = evaluateEasing(start.easing, Math.max(0, Math.min(1, localProgress)));
  if (easedProgress === null) return null;
  const fromColor = parseColor(start.color);
  const toColor = parseColor(end.color);
  const fromAngle = parseRotate(start.transform);
  const toAngle = parseRotate(end.transform);
  if (!fromColor || !toColor || fromAngle === null || toAngle === null) return null;
  const color = `rgb(${fromColor.map((channel, position) =>
    Math.max(0, Math.min(255, Math.round(interpolate(channel, toColor[position]!, easedProgress))))).join(', ')})`;
  return {
    currentTime: time,
    duration,
    progress,
    easedProgress,
    color,
    transform: formatMatrix(interpolate(fromAngle, toAngle, easedProgress)),
  };
}

/**
 * Wrap computed style while overriding only color and transform.
 * @param style - Original CSSStyleDeclaration from Happy DOM.
 * @param sample - Interpolated animation color and rotation.
 * @returns Proxy retaining all other properties and method bindings.
 */
function overlayComputedStyle(style: CSSStyleDeclaration, sample: AnimationSample): CSSStyleDeclaration {
  return new Proxy(style, {
    get(target, property) {
      if (property === 'color') return sample.color;
      if (property === 'transform') return sample.transform;
      if (property === 'getPropertyValue') {
        return (name: string): string => {
          if (name === 'color') return sample.color;
          if (name === 'transform') return sample.transform;
          return target.getPropertyValue(name);
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * Install the Happy DOM WAAPI/computed-style compatibility bridge.
 *
 * The adapter modifies only the provided window's methods and returns a
 * restoration callback. Unsupported animations retain the original style.
 *
 * @param window - Happy DOM window to patch.
 * @param events - Optional diagnostics; callback failures are ignored.
 * @returns Function restoring the original method descriptors.
 */
export function installAnimationComputedStyleBridge(
  window: AnimationWindow,
  events: AnimationBridgeEvents = {},
): () => void {
  const prototype = window.Element?.prototype;
  const originalAnimate = prototype?.animate;
  const originalStyle = window.getComputedStyle;
  if (typeof originalAnimate !== 'function' || typeof originalStyle !== 'function') {
    throw new TypeError('动画适配器需要 Element.animate 和 getComputedStyle');
  }
  const animateDescriptor = Object.getOwnPropertyDescriptor(prototype, 'animate');
  const styleDescriptor = Object.getOwnPropertyDescriptor(window, 'getComputedStyle');
  if (animateDescriptor?.configurable === false || styleDescriptor?.configurable === false) {
    throw new TypeError('动画适配器无法覆盖不可配置的方法');
  }

  const byElement = new WeakMap<Element, Array<{ animation: Animation; keyframes: unknown; timing: unknown }>>();
  /**
   * Invoke an optional diagnostics hook without affecting signing.
   * @typeParam T - Diagnostic payload shape.
   * @param listener - Hook to invoke, if supplied.
   * @param value - Metadata delivered to the hook.
   * @returns Nothing.
   */
  const report = <T>(listener: ((value: T) => void) | undefined, value: T): void => {
    try { listener?.(value); } catch { /* Diagnostics never affect SDK execution. */ }
  };

  Object.defineProperty(prototype, 'animate', {
    configurable: true,
    writable: true,
    enumerable: animateDescriptor?.enumerable ?? false,
    value: function (this: Element, keyframes: Keyframe[] | PropertyIndexedKeyframes, timing?: number | KeyframeAnimationOptions) {
      const animation = Reflect.apply(originalAnimate, this, [keyframes, timing]) as Animation;
      const records = byElement.get(this) ?? [];
      records.push({ animation, keyframes, timing });
      byElement.set(this, records);
      report(events.onCreate, {
        element: this.tagName ?? null,
        keyframes: normalizeKeyframes(keyframes),
      });
      return animation;
    },
  });

  Object.defineProperty(window, 'getComputedStyle', {
    configurable: true,
    writable: true,
    enumerable: styleDescriptor?.enumerable ?? false,
    value: function (this: AnimationWindow, element: Element, pseudoElement?: string | null) {
      const style = Reflect.apply(originalStyle, this, [element, pseudoElement]) as CSSStyleDeclaration;
      if (pseudoElement) return style;
      const records = byElement.get(element);
      if (!records?.length) return style;
      for (let index = records.length - 1; index >= 0; index--) {
        const { animation, keyframes, timing } = records[index]!;
        if (animation.playState === 'idle' || animation.effect === null) continue;
        const effectiveTiming = animation.effect?.getTiming() ?? timing;
        const sample = sampleAnimationAtTime({ keyframes, timing: effectiveTiming, currentTime: animation.currentTime });
        if (!sample) {
          report(events.onUnsupported, { element: element.tagName ?? null, reason: '不支持的关键帧或动画时间' });
          continue;
        }
        report(events.onSample, sample);
        return overlayComputedStyle(style, sample);
      }
      return style;
    },
  });

  return (): void => {
    if (animateDescriptor) Object.defineProperty(prototype, 'animate', animateDescriptor);
    else Reflect.deleteProperty(prototype, 'animate');
    if (styleDescriptor) Object.defineProperty(window, 'getComputedStyle', styleDescriptor);
    else Reflect.deleteProperty(window, 'getComputedStyle');
  };
}
