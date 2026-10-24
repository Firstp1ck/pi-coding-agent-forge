import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FlagError,
  parseBackendArgs,
  parseCleanupArgs,
  parseDoctorArgs,
  parseExportArgs,
  parseResetArgs,
  parseSetupArgs,
  parseUsageArgs,
  tokenizeArgs,
} from "../../../src/config/flags.ts";

test("tokenizeArgs honours quotes and escapes", () => {
  assert.deepEqual(tokenizeArgs(`  a  "b c" 'd "e"' f\\ g "" `), ["a", "b c", 'd "e"', "f g", ""]);
  assert.deepEqual(tokenizeArgs(""), []);
  assert.throws(() => tokenizeArgs(`"open`), FlagError);
});

test("parseSetupArgs: backend and every flag from the spec table", () => {
  assert.deepEqual(parseSetupArgs(""), {
    acceptBilling: false,
    acceptWindowsLicense: false,
    fix: false,
    noFix: false,
    project: false,
    purgeTooling: false,
  });
  const all = parseSetupArgs(
    "remote-linux-docker --host user@pi5 --targets linux,windows,linux --api-key-env MY_KEY --accept-billing --accept-windows-license --fix --project --purge-tooling",
  );
  assert.equal(all.backend, "remote-linux-docker");
  assert.equal(all.host, "user@pi5");
  assert.deepEqual(all.targets, ["linux", "windows"]);
  assert.equal(all.apiKeyEnv, "MY_KEY");
  assert.ok(all.acceptBilling && all.acceptWindowsLicense && all.fix && all.project && all.purgeTooling);
  assert.equal(parseSetupArgs("--host=raspi5 docker-linux --no-fix").host, "raspi5");
  assert.equal(parseSetupArgs("docker-linux --no-fix").noFix, true);
});

test("parseSetupArgs rejects bad input with clear messages", () => {
  assert.throws(() => parseSetupArgs("docker-linux --fix --no-fix"), /--fix and --no-fix cannot be combined/);
  assert.throws(() => parseSetupArgs("--yes"), (e) => e instanceof FlagError && /unknown flag --yes; valid flags: --host, --targets.*--purge-tooling/.test(e.message));
  assert.throws(() => parseSetupArgs("kvm-linux"), /unknown backend "kvm-linux"; known backends: docker-linux/);
  assert.throws(() => parseSetupArgs("docker-linux extra"), /unexpected argument "extra"/);
  assert.throws(() => parseSetupArgs("--host"), /--host needs a value/);
  assert.throws(() => parseSetupArgs("--host --fix"), /--host needs a value/);
  assert.throws(() => parseSetupArgs("--fix=yes"), /--fix takes no value/);
  assert.throws(() => parseSetupArgs("--fix --fix"), /given more than once/);
  assert.throws(() => parseSetupArgs("--targets linux,beos"), /unknown target "beos"/);
  assert.throws(() => parseSetupArgs("--api-key-env 'bad name'"), /environment variable name/);
});

test("parsers for the other commands", () => {
  assert.deepEqual(parseDoctorArgs(""), {});
  assert.deepEqual(parseDoctorArgs("docker-linux"), { backend: "docker-linux" });
  assert.throws(() => parseDoctorArgs("--fix"), /\/gui-doctor: unknown flag --fix; valid flags: --host/);

  assert.deepEqual(parseBackendArgs("docker-linux --project"), { backend: "docker-linux", project: true });
  assert.throws(() => parseBackendArgs(""), /missing backend/);

  assert.deepEqual(parseUsageArgs(""), {});
  assert.deepEqual(parseUsageArgs("s1"), { session: "s1" });

  assert.deepEqual(parseCleanupArgs(""), { all: false, deps: false });
  assert.deepEqual(parseCleanupArgs("--all --deps"), { all: true, deps: true });
  assert.deepEqual(parseCleanupArgs("docker-linux"), { backend: "docker-linux", all: false, deps: false });
  assert.throws(() => parseCleanupArgs("docker-linux --all"), /not both/);

  assert.deepEqual(parseResetArgs("docker-linux"), { backend: "docker-linux" });
  assert.throws(() => parseResetArgs(""), /missing backend/);

  assert.deepEqual(parseExportArgs(`s1 "/home/me/GUI exports"`), { session: "s1", dest: "/home/me/GUI exports" });
  assert.throws(() => parseExportArgs("s1"), /missing destination/);
  assert.throws(() => parseExportArgs(""), /missing session and destination/);
  assert.throws(() => parseExportArgs("a b c"), /unexpected argument "c"/);
});

test("I: /gui-setup --cloud and --rate-usd-per-hour; /gui-doctor --host", () => {
  const parsed = parseSetupArgs("cua --cloud gcp --rate-usd-per-hour 1.25 --accept-billing");
  assert.equal(parsed.cloud, "gcp");
  assert.equal(parsed.rateUsdPerHour, 1.25);
  assert.equal(parsed.acceptBilling, true);
  assert.throws(() => parseSetupArgs("cua --cloud azure"), /unknown cloud "azure"; valid clouds: aws, gcp, hetzner, modal/);
  for (const bad of ["abc", "1e3", "-1", "1001"]) assert.throws(() => parseSetupArgs(`cua --rate-usd-per-hour=${bad}`), /--rate-usd-per-hour must be a number from 0 to 1000/, bad);
  assert.equal(parseSetupArgs("remote-linux-docker --host raspi5 --purge-tooling").purgeTooling, true);
  assert.deepEqual(parseDoctorArgs("remote-linux --host raspi5"), { backend: "remote-linux", host: "raspi5" });
  assert.deepEqual(parseDoctorArgs("--host=user@box"), { host: "user@box" });
  assert.throws(() => parseDoctorArgs("remote-linux --host"), /--host needs a value/);
});

test("V13: /gui-setup --image takes an image alias or registry reference", async () => {
  const { parseSetupArgs } = await import("../../../src/config/flags.ts");
  assert.equal(parseSetupArgs("cua --image ghcr.io/me/desktop:2").image, "ghcr.io/me/desktop:2");
  assert.equal(parseSetupArgs("cua --image linux").image, "linux");
  for (const bad of ["'-x'", "'a b'", "'$(id)'"]) assert.throws(() => parseSetupArgs(`cua --image ${bad}`), /--image must be/, bad);
});
