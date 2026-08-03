import { NextRequest, NextResponse } from "next/server";
import { isSameOriginRequest } from "@/lib/request-origin";

/**
 * Same-origin guard for all /api routes.
 *
 * agent-vis exposes filesystem read/write and a session-mutating API. Because
 * the app has no CORS headers, the browser already blocks cross-origin *reads*
 * of responses — but "simple" cross-origin POST/DELETE requests still reach the
 * server (no preflight), which is a CSRF vector: any website open in the
 * victim's browser could write files or rewrite .env.local.
 *
 * Browsers always attach an `Origin` header to cross-origin requests (and to
 * every unsafe-method request), so we reject any request whose Origin/Referer
 * host does not match the host the app is served on. Requests with neither
 * header are non-browser clients (curl, native tooling) and are allowed — they
 * are not the CSRF threat this guards against.
 */
export function middleware(req: NextRequest) {
  if (!isSameOriginRequest(
    req.headers.get("host"),
    req.headers.get("origin"),
    req.headers.get("referer"),
  )) {
    return new NextResponse("Cross-origin request blocked", { status: 403 });
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/api/:path*"],
};
