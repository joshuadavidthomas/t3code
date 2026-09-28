import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import * as Socket from "effect/unstable/socket/Socket";

import { makeSpritesClient, type SpritesClient } from "./SpritesClient.ts";

const withClient = <A, E>(
  responses: Array<Response>,
  run: (client: SpritesClient) => Effect.Effect<A, E>,
  socket: Socket.WebSocketConstructor["Service"] = () => {
    throw new Error("unexpected websocket");
  },
) => {
  let calls = 0;
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      const response = responses[Math.min(calls++, responses.length - 1)]!;
      return HttpClientResponse.fromWeb(request, response);
    }),
  );
  return makeSpritesClient("secret").pipe(
    Effect.flatMap(run),
    Effect.provideService(HttpClient.HttpClient, http),
    Effect.provideService(Socket.WebSocketConstructor, socket),
    Effect.map((value) => ({ value, calls })),
  );
};

class FakeSocket extends EventTarget implements Socket.WebSocketLike {
  readonly readyState = 0;
  binaryType = "arraybuffer";
  readonly sent: Array<Uint8Array> = [];
  closed = false;

  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    this.sent.push(data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer));
  }
  close(): void {
    this.closed = true;
  }
  open() {
    this.dispatchEvent(new Event("open"));
  }
  message(data: string | Uint8Array) {
    this.dispatchEvent(
      new MessageEvent("message", { data: typeof data === "string" ? data : data.buffer }),
    );
  }
}

describe("SpritesClient", () => {
  it.effect("uploads bytes through the SDK filesystem endpoint", () =>
    Effect.gen(function* () {
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          expect(request.method).toBe("PUT");
          const url = new URL(request.url);
          expect(url.pathname).toBe("/v1/sprites/test-sprite/fs/write");
          expect(url.searchParams.get("path")).toBe("/home/sprite/t3/runtime.tar.gz");
          expect(url.searchParams.get("mkdirParents")).toBe("true");
          expect(request.body._tag).toBe("Uint8Array");
          return HttpClientResponse.fromWeb(request, new Response(null, { status: 204 }));
        }),
      );
      const client = yield* makeSpritesClient("test-token").pipe(
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.provideService(Socket.WebSocketConstructor, () => {
          throw new Error("unexpected websocket");
        }),
      );
      yield* client.upload(
        "test-sprite",
        "/home/sprite/t3/runtime.tar.gz",
        new Uint8Array([1, 2, 3]),
      );
    }),
  );
  it.effect("makes the Sprite URL public through the SDK update endpoint", () =>
    Effect.gen(function* () {
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          expect(request.method).toBe("PUT");
          expect(new URL(request.url).pathname).toBe("/v1/sprites/test-sprite");
          expect(request.body._tag).toBe("Uint8Array");
          if (request.body._tag === "Uint8Array")
            expect(new TextDecoder().decode(request.body.body)).toBe(
              '{"url_settings":{"auth":"public"}}',
            );
          return HttpClientResponse.fromWeb(request, Response.json({}));
        }),
      );
      const client = yield* makeSpritesClient("test-token").pipe(
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.provideService(Socket.WebSocketConstructor, () => {
          throw new Error("unexpected websocket");
        }),
      );
      yield* client.makeUrlPublic("test-sprite");
    }),
  );

  it.effect("does not repeat allocations, distinguishes find 404, and sanitizes errors", () =>
    Effect.gen(function* () {
      const retried = yield* withClient(
        [new Response("private", { status: 503 }), Response.json({ id: "id", url: "https://s" })],
        (client) => client.create("sprite").pipe(Effect.exit),
      );
      expect(retried.calls).toBe(1);
      expect(Exit.isFailure(retried.value)).toBe(true);

      const missing = yield* withClient([new Response(null, { status: 404 })], (client) =>
        client.find("missing"),
      );
      expect(missing.value).toBeNull();

      const failed = yield* withClient(
        [new Response("sensitive-body", { status: 403 })],
        (client) => client.find("x"),
      ).pipe(Effect.exit);
      expect(String(failed)).not.toContain("sensitive-body");
      expect(String(failed)).not.toContain("secret");
    }),
  );

  it.effect("preserves exec frames, captures stdout, and closes when interrupted", () =>
    Effect.gen(function* () {
      const sockets: Array<FakeSocket> = [];
      const created = yield* Queue.unbounded<FakeSocket>();
      const constructor: Socket.WebSocketConstructor["Service"] = () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        Queue.offerUnsafe(created, socket);
        return socket;
      };
      const program = withClient(
        [],
        (client) =>
          Effect.gen(function* () {
            const first = yield* client.exec("sprite", "cat", "hello").pipe(Effect.forkChild);
            const socket = yield* Queue.take(created);
            socket.open();
            socket.message(new Uint8Array([1, ...new TextEncoder().encode("world")]));
            socket.message(new Uint8Array([3, 0]));
            const output = yield* Fiber.join(first);

            const cancelled = yield* client.exec("sprite", "sleep 1", "").pipe(Effect.forkChild);
            yield* Queue.take(created);
            yield* Fiber.interrupt(cancelled);
            return output;
          }),
        constructor,
      );
      return yield* program.pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(result.value).toBe("world");
            expect([...sockets[0]!.sent[0]!]).toEqual([0, ...new TextEncoder().encode("hello")]);
            expect([...sockets[0]!.sent[1]!]).toEqual([4]);
            expect(sockets[1]!.closed).toBe(true);
          }),
        ),
      );
    }),
  );

  it.effect("fails a service operation when its NDJSON reports an error or nonzero exit", () =>
    Effect.gen(function* () {
      for (const event of [
        '{"type":"error","data":"credential","timestamp":1}',
        '{"type":"exit","exit_code":7,"timestamp":1}',
      ]) {
        const result = yield* withClient([new Response(`${event}\n`, { status: 200 })], (client) =>
          client.putService("sprite", "web", { cmd: "node", args: ["server.js"] }),
        ).pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        expect(String(result)).not.toContain("credential");
      }
    }),
  );

  it.effect("accepts re-registering a service that is already running, as a retry does", () =>
    Effect.gen(function* () {
      const body =
        '{"message":"Service already running with that command, use POST /v1/services/t3/restart if you want to restart it","name":"t3"}';
      yield* withClient([new Response(`${body}\n`, { status: 200 })], (client) =>
        client.putService("sprite", "t3", { cmd: "node", args: ["server.js"] }),
      );
    }),
  );
});
