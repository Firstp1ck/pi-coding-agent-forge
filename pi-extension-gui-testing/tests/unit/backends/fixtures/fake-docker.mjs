/**
 * A fake `docker` executable for process-level integration tests on hosts
 * without Docker. State lives in files under the directory given as the
 * first argument (the generated wrapper script passes it), so separate CLI
 * invocations share it. `run -i` hosts the in-memory fake helper on real
 * stdio and exits when stdin closes, like `docker run -i --rm` with the real
 * helper as entrypoint.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FakeHelperChild, HEALTHY_INFO, inspectFromArgv, parseRunArgv } from "../fakes.mjs";

const [stateDir, ...rawArgs] = process.argv.slice(2);
const args = rawArgs[0] === "--host" ? rawArgs.slice(2) : rawArgs;
const containers = join(stateDir, "containers");
mkdirSync(containers, { recursive: true });
const out = (text) => process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
const fail = (text, code = 1) => {
  process.stderr.write(`${text}\n`);
  process.exit(code);
};
const imageFile = join(stateDir, "image.json");
const saved = () => readdirSync(containers).map((f) => JSON.parse(readFileSync(join(containers, f), "utf8")));
const labelsOf = (argv) => Object.fromEntries(parseRunArgv(argv).all("--label").map((l) => l.split(/=(.*)/s).slice(0, 2)));
const save = (name, argv, extra = {}) => {
  const labels = labelsOf(argv);
  writeFileSync(join(containers, `${name}.json`), JSON.stringify({ id: `id-${name}`, name, argv, session: labels["pi-gui-testing.session"], owner: labels["pi-gui-testing.owner"], ...extra }));
};
const drop = (name) => rmSync(join(containers, `${name}.json`), { force: true });

const [command, sub] = args;
if (command === "--version") out("Docker version 29.9.1, build fake");
else if (command === "context" && sub === "inspect") out(JSON.stringify({ Name: "default", Endpoints: { docker: { Host: "unix:///var/run/docker.sock" } } }));
else if (command === "info") out(JSON.stringify(HEALTHY_INFO));
else if (command === "version") out("29.9.1");
else if (command === "image" && sub === "inspect") {
  if (!existsSync(imageFile)) fail("Error response from daemon: No such image: pi-gui-testing-base:0.1.0");
  out(readFileSync(imageFile, "utf8"));
} else if (command === "image" && sub === "ls") {
  if (existsSync(imageFile)) out(JSON.parse(readFileSync(imageFile, "utf8")).Id);
} else if (command === "image" && sub === "rm") rmSync(imageFile, { force: true });
else if (command === "build") {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const tar = Buffer.concat(chunks);
  if (tar.toString("latin1", 257, 262) !== "ustar" || !tar.includes("FROM debian")) fail("build context is not a tar with the Dockerfile");
  const version = args[args.indexOf("--build-arg") + 1].split("=")[1];
  writeFileSync(imageFile, JSON.stringify({ Id: `sha256:${"ab".repeat(32)}`, Architecture: "amd64", Config: { Labels: { "pi-gui-testing.base": "true", "pi-gui-testing.version": version, "pi-gui-testing.protocol": "1" } } }));
  writeFileSync(join(stateDir, "build-context-bytes"), String(tar.length));
  out("Successfully built fake");
} else if (command === "create") {
  const name = parseRunArgv(["docker", ...args]).one("--name");
  save(name, ["docker", ...args]);
  out(`id-${name}`);
} else if (command === "run") {
  const argv = ["docker", ...args];
  const p = parseRunArgv(argv);
  const name = p.one("--name");
  if (p.one("--entrypoint") === "/bin/sh") {
    // docker.bind-uid probe: touch the file in the bind-mounted dir.
    const bind = p.all("-v").find((v) => v.endsWith(":/probe"));
    writeFileSync(join(bind.split(":")[0], "owned"), "");
  } else {
    save(name, argv, { cliPid: process.pid, env: { PI_GUI_TESTING_TOKEN: process.env.PI_GUI_TESTING_TOKEN } });
    const helper = new FakeHelperChild(argv, { env: { PI_GUI_TESTING_TOKEN: process.env.PI_GUI_TESTING_TOKEN } });
    process.stdin.pipe(helper.stdin);
    helper.stdout.pipe(process.stdout);
    const end = () => {
      drop(name);
      process.exit(0);
    };
    process.on("SIGTERM", end);
    await helper.exited;
    end();
  }
} else if (command === "container" && sub === "inspect") {
  const found = saved().find((c) => c.name === args.at(-1) || c.id === args.at(-1));
  if (!found) fail(`Error: No such container: ${args.at(-1)}`);
  out(JSON.stringify([inspectFromArgv(found.argv, found.env ?? {})]));
} else if (command === "ps") {
  const filter = /label=pi-gui-testing\.session(?:=(\S+))?/.exec(args.join(" "));
  for (const c of saved()) if (!filter?.[1] || c.session === filter[1]) out([c.id, c.name, c.session, c.owner].join("\t"));
} else if ((command === "volume" || command === "network") && sub === "ls") {
  // none
} else if (command === "rm") {
  const target = args.at(-1);
  const found = saved().find((c) => c.name === target || c.id === target);
  if (found) {
    drop(found.name);
    if (found.cliPid) {
      try {
        process.kill(found.cliPid, "SIGTERM");
      } catch {}
    }
  }
} else fail(`fake docker: unsupported command: ${args.join(" ")}`, 125);
