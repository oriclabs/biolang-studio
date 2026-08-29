const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isLoopbackUrl(value: string | URL): boolean {
  try {
    const url = value instanceof URL ? value : new URL(value);
    return LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function isAllowedContentUrl(value: unknown, allowLocal = false): value is string {
  if (typeof value !== "string") return false;
  if (allowLocal && value.startsWith("/") && !value.startsWith("//") && !value.split("/").includes("..")) return true;
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    return url.protocol === "https:" || (allowLocal && url.protocol === "http:" && isLoopbackUrl(url));
  } catch {
    return false;
  }
}
