import { preview } from "vite";

export default async function startStudioPreview() {
  const server = await preview({
    preview: { host: "127.0.0.1", port: 4178, strictPort: true },
  });

  return async () => {
    await new Promise<void>((resolve, reject) => {
      server.httpServer.close(error => error ? reject(error) : resolve());
    });
  };
}
