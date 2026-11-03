export const PRIVATE_NO_STORE_HEADERS = Object.freeze({
  "cache-control": "private, no-store",
  pragma: "no-cache",
});

export function cookieValue(request: Request, name: string): string | null {
  const raw = request.headers.get("cookie") ?? "";
  for (const part of raw.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
}

/** Bearer credentials intentionally cannot mutate machine-wide agent login. */
export function hasBrowserSession(
  request: Request,
  cookieName: string,
  validate: (token: string | null) => boolean,
): boolean {
  return validate(cookieValue(request, cookieName));
}
