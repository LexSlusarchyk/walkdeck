export type BrowserName = "chrome" | "edge" | "brave" | "safari" | "firefox" | "other";

export type BleHost = {
  api: boolean;
  embedded: boolean;
  apple: boolean;
  silicon: boolean | null;
  browser: BrowserName;
};

export function detectHost(): BleHost {
  const ua = navigator.userAgent;
  let browser: BrowserName = "other";
  if (/Edg\//.test(ua)) browser = "edge";
  else if (/Firefox\//.test(ua)) browser = "firefox";
  else if (/Safari\//.test(ua) && !/Chrome|Chromium|CriOS/.test(ua)) browser = "safari";
  else if (/Chrome|Chromium|CriOS/.test(ua)) browser = "chrome";
  const brave = (navigator as Navigator & { brave?: unknown }).brave;
  if (brave && browser === "chrome") browser = "brave";
  let embedded = false;
  try {
    embedded = window.top !== window.self;
  } catch {
    embedded = true;
  }
  return {
    api: typeof navigator.bluetooth !== "undefined",
    embedded,
    apple: /Macintosh|Mac OS X/.test(ua),
    silicon: null,
    browser,
  };
}

type UaData = {
  getHighEntropyValues: (
    hints: string[],
  ) => Promise<{ architecture?: string; platform?: string }>;
};

export async function refineHost(host: BleHost): Promise<BleHost> {
  const ua = navigator as Navigator & { userAgentData?: UaData };
  if (!ua.userAgentData) return host;
  try {
    const data = await ua.userAgentData.getHighEntropyValues(["architecture", "platform"]);
    const apple = host.apple || /mac/i.test(data.platform ?? "");
    const architecture = (data.architecture ?? "").toLowerCase();
    const silicon = architecture ? /arm|aarch64/.test(architecture) : host.silicon;
    return { ...host, apple, silicon };
  } catch {
    return host;
  }
}

export function macName(host: BleHost | null): string {
  if (!host?.apple) return "your MacBook Pro";
  if (host.silicon === false) return "this Mac";
  return "this MacBook Pro";
}

export function blocker(host: BleHost): string | null {
  if (host.browser === "safari") {
    return "Safari on a MacBook can't open Bluetooth. Use Chrome, Edge, Brave, or Arc — they run on the M4 chip.";
  }
  if (host.browser === "firefox") {
    return "Firefox can't open Bluetooth. On your MacBook Pro, use Chrome, Edge, Brave, or Arc.";
  }
  if (!host.api) {
    return "This browser has no Bluetooth. On your MacBook Pro, use Chrome, Edge, Brave, or Arc.";
  }
  return null;
}
