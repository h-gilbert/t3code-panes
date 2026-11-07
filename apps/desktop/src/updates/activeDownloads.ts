const downloads = new Set<Electron.DownloadItem>();

export function trackDesktopDownload(item: Electron.DownloadItem): void {
  downloads.add(item);
  item.once("done", () => downloads.delete(item));
}

export function hasActiveDesktopDownloads(): boolean {
  return downloads.size > 0;
}
