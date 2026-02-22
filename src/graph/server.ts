import { createServer, type Server } from 'node:http';
import { handleRequest } from './handler.js';

let server: Server | null = null;

/**
 * Start the graph visualization HTTP server.
 * Returns the actual port the server is listening on.
 */
export function startGraphServer(port: number = 3333): Promise<number> {
  return new Promise((resolve, reject) => {
    server = createServer(handleRequest);

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        // Try next port
        console.error(
          `Port ${port} is in use, trying ${port + 1}...`,
        );
        startGraphServer(port + 1).then(resolve).catch(reject);
      } else {
        reject(err);
      }
    });

    server.listen(port, () => {
      console.error(
        `Knowledge graph visualization: http://localhost:${port}`,
      );
      resolve(port);
    });
  });
}

/**
 * Stop the graph visualization server.
 */
export function stopGraphServer(): Promise<void> {
  return new Promise((resolve) => {
    if (server) {
      server.close(() => {
        server = null;
        resolve();
      });
    } else {
      resolve();
    }
  });
}
