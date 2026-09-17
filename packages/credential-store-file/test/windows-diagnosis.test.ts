import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

test("observe Windows native credential replacement behavior", { skip: process.platform !== "win32", timeout: 120_000 }, async () => {
  const { stdout } = await promisify(execFile)(process.execPath, [
    fileURLToPath(new URL("../../../.github/diagnostics/windows-replace.mjs", import.meta.url)),
  ], { timeout: 110_000, windowsHide: true, maxBuffer: 1024 * 1024 });
  console.log(stdout);
});
