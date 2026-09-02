import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_ROOT = path.join(PROJECT_ROOT, "js");

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const absolutePath = path.join(directory, entry.name);
    return entry.isDirectory()
      ? sourceFiles(absolutePath)
      : entry.isFile() && entry.name.endsWith(".js")
        ? [absolutePath]
        : [];
  }));
  return nested.flat();
}

test("production runtime contains no legacy thresholds or generated sensor mock pipeline", async () => {
  const forbiddenPatterns = [
    /WARNING_THRESHOLDS/,
    /DISTRIBUTION_CATEGORIES/,
    /MOCK_STATIONS/,
    /MOCK_DEVICE_SETTINGS/,
    /useMockData/,
    /Math\.random\s*\(/,
    /station\.maxTilt/
  ];
  const violations = [];
  for (const filename of await sourceFiles(SOURCE_ROOT)) {
    const source = await readFile(filename, "utf8");
    forbiddenPatterns.forEach((pattern) => {
      if (pattern.test(source)) {
        violations.push(`${path.relative(PROJECT_ROOT, filename)}: ${pattern}`);
      }
    });
  }
  assert.deepEqual(violations, []);
});

test("application runtime uses authenticated real-data services and no legacy Dashboard API", async () => {
  const source = await readFile(path.join(SOURCE_ROOT, "app.js"), "utf8");
  assert.match(source, /SensorDataService/);
  assert.match(source, /TowerHistoryService/);
  assert.match(source, /SettingsService/);
  assert.doesNotMatch(source, /ApiService|processDashboardPayload|processSensorPacket|refreshDashboard/);
});
