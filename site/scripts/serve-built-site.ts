import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";

const root = path.join(process.cwd(), "site", "dist");
const port = 4321;
const contentTypes: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

const server = createServer((request, response) => {
  const pathname = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`)
    .pathname;
  const relative = pathname.replace(/^\//u, "");
  const requested =
    pathname === "/"
      ? "index.html"
      : pathname.endsWith("/")
        ? path.join(relative, "index.html")
        : relative;
  const candidate = path.resolve(root, requested);
  const file =
    candidate.startsWith(`${root}${path.sep}`) &&
    existsSync(candidate) &&
    statSync(candidate).isFile()
      ? candidate
      : path.join(root, "404.html");
  const status = file === candidate ? 200 : 404;

  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": contentTypes[path.extname(file)] ?? "application/octet-stream",
  });
  createReadStream(file).pipe(response);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Static site test server listening on http://127.0.0.1:${port}`);
});

function shutDown(): void {
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutDown);
process.on("SIGTERM", shutDown);
