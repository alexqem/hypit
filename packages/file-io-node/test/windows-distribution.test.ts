import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Temporary diagnostic branch only: execute the real packaged CLI on Windows.
test("Windows installs the distribution tarball, renders and exports a video", {
  skip: process.platform !== "win32", timeout: 900_000,
}, async () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const { version } = JSON.parse(await readFile(new URL("../../../package.json", import.meta.url), "utf8"));
  if (!/^\d+\.\d+\.\d+$/u.test(version)) throw new Error("Expected package version");
  const command = `npm run pack:distribution && npm run check:distribution -- dist/release/hypit-hypit-${version}.tgz`;
  try {
    const { stdout, stderr } = await promisify(execFile)(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", command], {
      cwd: root, windowsHide: true, timeout: 880_000, maxBuffer: 32 * 1024 * 1024,
    });
    await writeFile(new URL("../../../windows-distribution.log", import.meta.url), stdout + stderr);
    console.log(stdout.slice(-18000));
    if (stderr) console.log(stderr.slice(-4000));
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string };
    console.log(failure.stdout?.slice(-18000));
    console.error(failure.stderr?.slice(-12000));
    throw error;
  }
});
