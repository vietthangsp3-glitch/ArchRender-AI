export const SESSION_COOKIE_NAME =
  process.env["NODE_ENV"] === "production"
    ? "__Host-archrender_session"
    : "archrender_session";

export function sessionCookieOptions(expires: Date) {
  return {
    httpOnly: true,
    secure: process.env["NODE_ENV"] === "production",
    sameSite: "lax" as const,
    path: "/",
    expires,
    priority: "high" as const,
  };
}

export function expiredSessionCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env["NODE_ENV"] === "production",
    sameSite: "lax" as const,
    path: "/",
    expires: new Date(0),
    maxAge: 0,
    priority: "high" as const,
  };
}
