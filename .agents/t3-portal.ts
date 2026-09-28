// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";

// Local-only orb glue: fronts the Vite dev server so no tracked file changes.
// Amp's external proxy supplies the identity header; never expose this port
// outside the orb.
export function startPortalProxy(input: {
  listenPort: number;
  targetPort: number;
  publicOrigin: string;
  token: string;
}) {
  const host = new URL(input.publicOrigin).host;
  const authorize = (request: NodeHttp.IncomingMessage) => {
    const path = request.url?.split("?")[0];
    if (path !== "/ws" && !path?.startsWith("/api/")) return;
    const collaborator = String(request.headers["x-amp-authenticated"] ?? "")
      .split(",")
      .some((part) => part.trim() === "collaborator=yes");
    if (
      !collaborator ||
      request.headers.host !== host ||
      (request.headers.origin && request.headers.origin !== input.publicOrigin)
    )
      return;
    // T3's reusable dev credential covers HTTP and WS auth, and stays
    // server-side even when the portal iframe cannot store cookies. Stale T3
    // cookies would otherwise take precedence over it.
    delete request.headers.cookie;
    delete request.headers.dpop;
    request.headers.authorization = `Bearer ${input.token}`;
  };

  const server = NodeHttp.createServer((request, response) => {
    // Older portal links remain usable; the root needs no login redirect.
    if (request.url === "/__orb/login") {
      response.writeHead(303, { Location: "/", "Cache-Control": "no-store" }).end();
      return;
    }
    authorize(request);
    const upstream = NodeHttp.request(
      {
        host: "localhost",
        port: input.targetPort,
        method: request.method,
        path: request.url,
        headers: request.headers,
      },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      },
    );
    upstream.on("error", () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    request.pipe(upstream);
  });

  server.on("upgrade", (request, socket, head) => {
    authorize(request);
    const upstream = NodeNet.connect(input.targetPort, "localhost", () => {
      const lines = [`${request.method} ${request.url} HTTP/${request.httpVersion}`];
      for (let i = 0; i < request.rawHeaders.length; i += 2) {
        const name = request.rawHeaders[i]!;
        const lower = name.toLowerCase();
        if (lower === "cookie" || lower === "dpop" || lower === "authorization") continue;
        lines.push(`${name}: ${request.rawHeaders[i + 1]}`);
      }
      if (request.headers.cookie) lines.push(`Cookie: ${request.headers.cookie}`);
      if (request.headers.dpop) lines.push(`DPoP: ${String(request.headers.dpop)}`);
      if (request.headers.authorization)
        lines.push(`Authorization: ${request.headers.authorization}`);
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length > 0) upstream.write(head);
      upstream.pipe(socket).pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });

  server.listen(input.listenPort, "0.0.0.0");
  return server;
}
