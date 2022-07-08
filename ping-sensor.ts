import { z } from "https://deno.land/x/zod@v3.16.1/mod.ts";

// deno-lint-ignore no-explicit-any
const throttle = <Fn extends (...args: any[]) => any>(callback: Fn, ms: number) => {
  let timer: number;
  // deno-lint-ignore no-explicit-any
  return (...args: any[]) => {
    if (timer) return;
    timer = setTimeout(() => {
      callback(...args);
      timer = 0;
    }, ms);
  };
};

const server = Deno.listen({ port: 3080 });
console.log(`HTTP webserver running.  Access it at:  http://localhost:3080/`);

const CONFIG_FILE = "./config.json";
const HISTORY_LENGTH = 50;
const RESTART_AFTER_FAILURE = 10 * 1000; // 10 seconds
const RESTART_AFTER_ERROR = 60 * 1000; // 1 minute
const WRITE_CONFIG_THROTTLE = 10 * 1000; // 30 seconds

const Ip = z.string();
type IP = z.infer<typeof Ip>;

const State = z.enum(["active", "down", "unkown"]);
type State = z.infer<typeof State>;

const HistoryEntry = z.object({
  state: State,
  time: z.number(),
});
type HistoryEntry = z.infer<typeof HistoryEntry>;

const IPEntry = z.object({
  ip: z.string(), // ip or hostname
  state: z.optional(State),
  lastActive: z.number().optional(),
  history: z.array(HistoryEntry).optional(),
});
type IPEntry = z.infer<typeof IPEntry>;
interface IPEntryWithProcess extends IPEntry {
  process?: Deno.Process | undefined;
}

const inputParam = IPEntry;
const validIpList = z.array(inputParam);

const getJson = async (filePath: string) => {
  const data = JSON.parse(await Deno.readTextFile(filePath));
  const result = validIpList.safeParse(data);
  return (result.success && result.data) || undefined;
};

const writeJson = (filePath: string, data: IPEntry[]) => Deno.writeTextFile(filePath, JSON.stringify(data, null, 2));

const readConfig = () => getJson(CONFIG_FILE);

const appendChunks = (a: Uint8Array, b: Uint8Array, numOfByteRead: number) => {
  const c = new Uint8Array(a.length + numOfByteRead);
  c.set(a, 0);
  c.set(b.slice(0, numOfByteRead), a.length);
  return c;
};

const writeConfiguration = throttle(() => {
  const ipEntries = Object.keys(active).map((ip) => {
    const result: IPEntryWithProcess = { state: "unkown", ...active[ip], history: active[ip].history?.slice(-HISTORY_LENGTH) ?? [] };
    delete result.process;
    return result as IPEntry;
  });
  writeJson(CONFIG_FILE, ipEntries);
}, WRITE_CONFIG_THROTTLE);

const active: Record<IP, IPEntryWithProcess> = {};

const updateActive = (ip: IP, partial: Omit<Partial<IPEntryWithProcess>, "history" | "lastActive">) => {
  const state = active[ip]?.state ?? "unkown";
  active[ip] = {
    ...(active[ip] ?? {
      ip,
      state: "unkown",
      lastActive: undefined,
      history: [],
    }),
    ...partial,
  };
  if (partial.state === "active") active[ip].lastActive = Date.now();
  if (state !== active[ip].state)
    active[ip].history!.push({
      state: active[ip].state!,
      time: Date.now(),
    });

  writeConfiguration();
};

const byteReader = (reader: (buffer: Uint8Array) => undefined | Promise<number | null>, handleChunk: (chunk: string, size: number) => boolean) =>
  new Promise<Uint8Array>((resolve) => {
    let chunk = new Uint8Array(0);
    const buf = new Uint8Array(100);
    const decoder = new TextDecoder();

    const read = () => {
      const promise = reader(buf);
      if (!promise) {
        return resolve(chunk);
      }
      promise.then(handler);
    };

    const handler = (numOfByteRead: number | null) => {
      if (numOfByteRead) {
        chunk = appendChunks(chunk, buf, numOfByteRead);
        if (!handleChunk(decoder.decode(buf), numOfByteRead)) {
          return resolve(chunk);
        }
        read();
      }
    };

    read();
  });

const checkIP = async (ip: IP) => {
  if (active[ip]?.process) return;

  const cmd = ["ping", ip];
  const p = await Deno.run({ cmd, stdout: "piped", stderr: "piped" });
  updateActive(ip, {
    process: p,
  });

  let done = false;
  p.status().then(() => {
    done = true;
    updateActive(ip, { process: undefined });
  });

  byteReader(
    (buffer) => p.stdout?.read(buffer),
    (chunk, size) => {
      if (size > 90) return !done;
      const timeout = chunk.match(/Request timeout/);
      updateActive(ip, { state: timeout ? "down" : "active" });
      if (timeout) {
        p.kill("SIGTERM");
      }
      return !done;
    }
  );
};

const ipEntries = await readConfig();
if (!ipEntries) throw new Error("Could not find any IP Adressess");
ipEntries.forEach((entry) => {
  active[entry.ip] = { history: [], lastActive: undefined, ...entry };
  active[entry.ip].state = "unkown";
});

const loop = async () => {
  try {
    const allIps = Object.keys(active);
    const inactiveIps = allIps.filter((ip) => active[ip].state !== "active");

    await Promise.all(inactiveIps.map((ip) => checkIP(ip)));

    Object.keys(active)
      .filter((ip) => {
        return !allIps.includes(ip);
      })
      .forEach((ip) => {
        console.log("killing ip", ip);
        if (active[ip].process) active[ip].process?.kill("SIGTERM");
        delete active[ip];
      });

    setTimeout(loop, RESTART_AFTER_FAILURE);
  } catch (e) {
    console.error("error", e);
    setTimeout(loop, RESTART_AFTER_ERROR);
  }
};

loop();

const renderToJson = () => {
  return Object.keys(active).map((ip) => {
    const ipEntry = active[ip];

    return {
      ip,
      history: ipEntry.history,
      state: ipEntry.state,
      lastActive: ipEntry.lastActive,
    };
  });
};

const serveHttp = async (conn: Deno.Conn) => {
  // This "upgrades" a network connection into an HTTP connection.
  const httpConn = Deno.serveHttp(conn);
  // Each request sent over the HTTP connection will be yielded as an async
  // iterator from the HTTP connection.
  for await (const requestEvent of httpConn) {
    // The native HTTP server uses the web standard `Request` and `Response`
    // objects.
    const body = JSON.stringify(renderToJson());
    // The requestEvent's `.respondWith()` method is how we send the response
    // back to the client.
    requestEvent.respondWith(
      new Response(body, {
        status: 200,
      })
    );
  }
};

// Connections to the server will be yielded up as an async iterable.
for await (const conn of server) {
  // In order to not be blocking, we need to handle each connection individually
  // without awaiting the function
  serveHttp(conn);
}
