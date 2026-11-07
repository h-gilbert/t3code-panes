export interface NativeBrowserMetadata {
  readonly brands: ReadonlyArray<{ readonly brand: string; readonly version: string }>;
  readonly fullVersionList: ReadonlyArray<{ readonly brand: string; readonly version: string }>;
  readonly platform: string;
  readonly platformVersion: string;
  readonly architecture: string;
  readonly bitness: string;
  readonly model: string;
  readonly mobile: boolean;
}

export function chromeUserAgent(userAgent: string): string {
  return userAgent.replace(/\s(?:Electron\/\S+|T3Code\S*)/gi, "");
}

export function chromeIdentity(
  userAgent: string,
  architecture: string,
  native?: NativeBrowserMetadata,
) {
  const fullVersion = /Chrome\/(\d+(?:\.\d+)*)/.exec(userAgent)?.[1];
  if (!fullVersion) throw new Error("Browser User-Agent has no Chrome version");
  const version = fullVersion.split(".")[0]!;
  const platform = userAgent.includes("Macintosh")
    ? "macOS"
    : userAgent.includes("Windows")
      ? "Windows"
      : "Linux";
  return {
    userAgent: chromeUserAgent(userAgent),
    userAgentMetadata: {
      brands: [
        ...(native?.brands?.filter((entry) => entry.brand !== "Google Chrome") ?? [
          { brand: "Not?A_Brand", version: "99" },
          { brand: "Chromium", version },
        ]),
        { brand: "Google Chrome", version },
      ],
      fullVersionList: [
        ...(native?.fullVersionList?.filter((entry) => entry.brand !== "Google Chrome") ?? [
          { brand: "Not?A_Brand", version: "99.0.0.0" },
          { brand: "Chromium", version: fullVersion },
        ]),
        { brand: "Google Chrome", version: fullVersion },
      ],
      fullVersion,
      platform: native?.platform ?? platform,
      platformVersion: native?.platformVersion ?? "",
      architecture: native?.architecture ?? (architecture.startsWith("arm") ? "arm" : "x86"),
      bitness: native?.bitness ?? (architecture.endsWith("64") ? "64" : "32"),
      model: native?.model ?? "",
      mobile: native?.mobile ?? false,
    },
  };
}
