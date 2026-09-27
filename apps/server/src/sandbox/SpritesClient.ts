import { SandboxSubmissionError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/unstable/http";
import * as Socket from "effect/unstable/socket/Socket";

const API = "https://api.sprites.dev/v1";
const MAX_BODY = 1024 * 1024;
const encoder = new TextEncoder();

const Sprite = Schema.Struct({ id: Schema.String, url: Schema.String });
const ExitMessage = Schema.Struct({ type: Schema.Literal("exit"), exit_code: Schema.Int });
const ServiceEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("error") }),
  Schema.Struct({ type: Schema.Literal("exit"), exit_code: Schema.Int }),
  Schema.Struct({ type: Schema.String }),
]);
const decodeExit = Schema.decodeUnknownOption(Schema.fromJsonString(ExitMessage));
const decodeSpriteJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Sprite));
const decodeServiceEventJson = Schema.decodeUnknownEffect(Schema.fromJsonString(ServiceEvent));

const unavailable = (message: string) =>
  new SandboxSubmissionError({ code: "unavailable", message });
const path = (value: string) => encodeURIComponent(value);

export interface SpritesClient {
  readonly find: (name: string) => Effect.Effect<typeof Sprite.Type | null, SandboxSubmissionError>;
  readonly create: (name: string) => Effect.Effect<typeof Sprite.Type, SandboxSubmissionError>;
  readonly remove: (name: string) => Effect.Effect<void, SandboxSubmissionError>;
  /** Serves the Sprite's URL without Sprites auth; T3's own auth gates it like any remote. */
  readonly makeUrlPublic: (name: string) => Effect.Effect<void, SandboxSubmissionError>;
  readonly exec: (
    name: string,
    script: string,
    input: string,
  ) => Effect.Effect<string, SandboxSubmissionError>;
  readonly upload: (
    name: string,
    remotePath: string,
    body: Uint8Array,
  ) => Effect.Effect<void, SandboxSubmissionError>;
  readonly putService: (
    name: string,
    serviceName: string,
    service: {
      readonly cmd: string;
      readonly args: readonly string[];
      readonly env?: Record<string, string>;
      readonly dir?: string;
      readonly http_port?: number;
      readonly needs?: readonly string[];
    },
  ) => Effect.Effect<void, SandboxSubmissionError>;
}

export const makeSpritesClient = Effect.fn("SpritesClient.make")(function* (credential: string) {
  const http = yield* HttpClient.HttpClient;
  const makeWebSocket = yield* Socket.WebSocketConstructor;

  const execute = (request: HttpClientRequest.HttpClientRequest) =>
    http
      .execute(request.pipe(HttpClientRequest.setHeader("Authorization", `Bearer ${credential}`)))
      .pipe(Effect.mapError(() => unavailable("Sprites API request failed.")));

  const checked = (request: HttpClientRequest.HttpClientRequest, allow404 = false) =>
    execute(request).pipe(
      Effect.flatMap((response) =>
        (response.status >= 200 && response.status < 300) || (allow404 && response.status === 404)
          ? Effect.succeed(response)
          : Effect.fail(unavailable(`Sprites API request failed (HTTP ${response.status}).`)),
      ),
    );

  const boundedText = (response: HttpClientResponse.HttpClientResponse) =>
    response.text.pipe(
      Effect.mapError(() => unavailable("Sprites API response could not be read.")),
      Effect.flatMap((text) =>
        encoder.encode(text).byteLength <= MAX_BODY
          ? Effect.succeed(text)
          : Effect.fail(unavailable("Sprites API response exceeded the size limit.")),
      ),
    );

  const decodeSpriteResponse = (response: HttpClientResponse.HttpClientResponse) =>
    boundedText(response).pipe(
      Effect.flatMap((text) =>
        decodeSpriteJson(text).pipe(
          Effect.mapError(() => unavailable("Sprites API returned an invalid response.")),
        ),
      ),
    );

  const find: SpritesClient["find"] = Effect.fn("SpritesClient.find")(function* (name) {
    const response = yield* checked(HttpClientRequest.get(`${API}/sprites/${path(name)}`), true);
    if (response.status === 404) return null;
    return yield* decodeSpriteResponse(response);
  });

  const create: SpritesClient["create"] = Effect.fn("SpritesClient.create")(function* (name) {
    const request = HttpClientRequest.post(`${API}/sprites`).pipe(
      HttpClientRequest.bodyJsonUnsafe({ name }),
    );
    return yield* checked(request).pipe(Effect.flatMap(decodeSpriteResponse));
  });

  const remove: SpritesClient["remove"] = (name) =>
    checked(HttpClientRequest.delete(`${API}/sprites/${path(name)}`), true).pipe(Effect.asVoid);

  const makeUrlPublic: SpritesClient["makeUrlPublic"] = (name) =>
    checked(
      HttpClientRequest.put(`${API}/sprites/${path(name)}`).pipe(
        HttpClientRequest.bodyJsonUnsafe({ url_settings: { auth: "public" } }),
      ),
    ).pipe(Effect.asVoid);

  const upload: SpritesClient["upload"] = (name, remotePath, body) => {
    // Official SDK source: https://github.com/superfly/sprites-js/blob/main/src/filesystem.ts
    // writeFile uses PUT /fs/write with these parameters.
    const url = new URL(`${API}/sprites/${path(name)}/fs/write`);
    url.searchParams.set("path", remotePath);
    url.searchParams.set("workingDir", "/home/sprite");
    url.searchParams.set("mkdirParents", "true");
    return checked(
      HttpClientRequest.put(url.toString()).pipe(
        HttpClientRequest.bodyUint8Array(body, "application/octet-stream"),
      ),
    ).pipe(Effect.asVoid);
  };

  const exec: SpritesClient["exec"] = (name, script, input) => {
    const url = new URL(`${API}/sprites/${path(name)}/exec`);
    url.protocol = "wss:";
    url.searchParams.set("stdin", "true");
    for (const arg of ["bash", "-c", script]) url.searchParams.append("cmd", arg);
    url.searchParams.set("path", "bash");

    const run = Effect.callback<string, SandboxSubmissionError>((resume) => {
      let socket: Socket.WebSocketLike | undefined;
      let done = false;
      let size = 0;
      const chunks: Array<Uint8Array> = [];
      const finish = (code: number) => {
        if (done) return;
        done = true;
        socket?.close(1000);
        if (code !== 0)
          return resume(Effect.fail(unavailable(`Sprite exec exited with code ${code}.`)));
        const output = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          output.set(chunk, offset);
          offset += chunk.byteLength;
        }
        resume(Effect.succeed(new TextDecoder().decode(output)));
      };
      try {
        socket = makeWebSocket(url.toString(), {
          headers: { Authorization: `Bearer ${credential}` },
        });
        if ("binaryType" in socket) socket.binaryType = "arraybuffer";
        socket.addEventListener("open", () => {
          const bytes = encoder.encode(input);
          const frame = new Uint8Array(bytes.byteLength + 1);
          frame.set(bytes, 1); // channel 0: stdin
          socket?.send(frame);
          socket?.send(new Uint8Array([4])); // channel 4: close stdin
        });
        socket.addEventListener("message", (event) => {
          if (done) return;
          if (typeof event.data === "string") {
            try {
              const decoded = decodeExit(event.data);
              if (decoded._tag === "Some") finish(decoded.value.exit_code);
            } catch {
              // Unknown text messages are protocol metadata and are ignored.
            }
            return;
          }
          const bytes =
            event.data instanceof ArrayBuffer
              ? new Uint8Array(event.data)
              : ArrayBuffer.isView(event.data)
                ? new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength)
                : undefined;
          if (!bytes || bytes.byteLength === 0) return;
          if (bytes[0] === 3 && bytes.byteLength === 2) return finish(bytes[1]!);
          if (bytes[0] !== 1) return;
          const chunk = bytes.slice(1);
          size += chunk.byteLength;
          if (size > MAX_BODY) {
            done = true;
            socket?.close(1000);
            resume(Effect.fail(unavailable("Sprite exec output exceeded the size limit.")));
          } else chunks.push(chunk);
        });
        socket.addEventListener("close", () => {
          if (!done) {
            done = true;
            resume(Effect.fail(unavailable("Sprite exec disconnected before reporting an exit.")));
          }
        });
        socket.addEventListener("error", () => {
          if (!done) {
            done = true;
            socket?.close(1000);
            resume(Effect.fail(unavailable("Sprite exec transport failed.")));
          }
        });
      } catch {
        done = true;
        socket?.close(1000);
        resume(Effect.fail(unavailable("Sprite exec transport failed.")));
      }
      return Effect.sync(() => {
        done = true;
        socket?.close(1000);
      });
    });
    return run.pipe(
      Effect.timeoutOrElse({
        duration: "10 minutes",
        orElse: () => Effect.fail(unavailable("Sprite exec timed out.")),
      }),
    );
  };

  const putService: SpritesClient["putService"] = (name, serviceName, service) =>
    checked(
      HttpClientRequest.put(`${API}/sprites/${path(name)}/services/${path(serviceName)}`).pipe(
        HttpClientRequest.bodyJsonUnsafe(service),
      ),
    ).pipe(
      Effect.flatMap(boundedText),
      Effect.flatMap((text) =>
        Effect.forEach(text.split("\n"), (line) => {
          if (line.trim() === "") return Effect.void;
          return decodeServiceEventJson(line).pipe(
            Effect.flatMap((event) =>
              event.type === "error" ||
              (event.type === "exit" && (!("exit_code" in event) || event.exit_code !== 0))
                ? Effect.fail(unavailable("Sprite service failed to start."))
                : Effect.void,
            ),
            Effect.mapError(() => unavailable("Sprites API returned an invalid service event.")),
          );
        }),
      ),
      Effect.asVoid,
    );

  return { find, create, remove, makeUrlPublic, exec, upload, putService } satisfies SpritesClient;
});
