#!/usr/bin/env node
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, cpSync, readdirSync, readFileSync, writeFileSync, createWriteStream } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { get as httpsGet } from "node:https";

// ─── Config ────────────────────────────────────────────────────
const WORKER_URL = "https://skill.dmd-fami.workers.dev";
const CK_KITS = [
  { name: "engineer", repo: "claudekit/claudekit-engineer" },
  { name: "marketing", repo: "claudekit/claudekit-marketing" },
];
const KIT_DIRS = ["agents", "skills", "rules", "hooks", "schemas", "scripts", "output-styles"];

// ─── Utils ─────────────────────────────────────────────────────
const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((r) => rl.question(q, r));
const run = (cmd, opts = {}) => {
  try {
    return execSync(cmd, { encoding: "utf8", stdio: "pipe", ...opts }).trim();
  } catch {
    return null;
  }
};

const log = (msg) => console.log(msg);
const ok = (msg) => console.log(`  OK  ${msg}`);
const info = (msg) => console.log(`  >>  ${msg}`);
const warn = (msg) => console.log(`  !!  ${msg}`);
const err = (msg) => console.log(`  XX  ${msg}`);

function fetch(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      headers,
    };
    httpsGet(options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetch(res.headers.location, headers).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode, body, headers: res.headers });
      });
    }).on("error", reject);
  });
}

function downloadFile(url, dest, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      headers,
    };
    httpsGet(options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadFile(res.headers.location, dest, headers).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => reject(new Error(`HTTP ${res.statusCode}: ${Buffer.concat(chunks).toString()}`)));
        return;
      }
      const stream = createWriteStream(dest);
      res.pipe(stream);
      stream.on("finish", () => { stream.close(); resolve(); });
    }).on("error", reject);
  });
}

function countItems(dir) {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() || d.name.endsWith(".md"))
    .length;
}

// ─── Platform Detection ────────────────────────────────────────
function detectPlatforms() {
  const home = homedir();
  const platforms = [];

  const claudeDir = join(home, ".claude");
  platforms.push({ name: "Claude Code", dir: claudeDir, detected: existsSync(claudeDir) });

  const codexPaths = [
    join(home, ".codex"),
    join(home, ".config", "codex"),
    join(home, "AppData", "Roaming", "codex"),
  ];
  let codexDir = join(home, ".codex");
  let codexDetected = false;
  for (const p of codexPaths) {
    if (existsSync(p)) { codexDir = p; codexDetected = true; break; }
  }
  platforms.push({ name: "Codex CLI", dir: codexDir, detected: codexDetected });

  return platforms;
}

// ─── Install Methods ───────────────────────────────────────────

async function installCKOfficial(targetDir) {
  log("");
  info("CK Official Install — requires gh auth login with CK account");
  log("");

  const ghVersion = run("gh --version");
  if (!ghVersion) {
    err("GitHub CLI (gh) not found. Install: https://cli.github.com/");
    return false;
  }
  ok(`GitHub CLI: ${ghVersion.split("\n")[0]}`);

  const ghAuth = run("gh auth status 2>&1");
  if (!ghAuth || ghAuth.includes("not logged")) {
    err("Not authenticated. Run: gh auth login");
    return false;
  }
  ok("GitHub authenticated");

  mkdirSync(targetDir, { recursive: true });

  for (const { name: kit, repo } of CK_KITS) {
    log("");
    info(`Fetching ${kit} kit...`);

    const tagsRaw = run(`gh api repos/${repo}/tags --jq '.[0].name' 2>/dev/null`);
    const release = tagsRaw || "main";
    info(`Version: ${release}`);

    const tmpClone = join(tmpdir(), `ck-${kit}-${Date.now()}`);
    run(`gh repo clone ${repo} "${tmpClone}" -- --depth=1 --branch ${release}`, { timeout: 120000 });

    if (!existsSync(join(tmpClone, ".claude"))) {
      warn(`${kit} clone failed — check GitHub access.`);
      continue;
    }

    const kitSource = join(tmpClone, ".claude");
    let copied = 0;
    for (const dir of KIT_DIRS) {
      const src = join(kitSource, dir);
      if (existsSync(src)) {
        const dest = join(targetDir, dir);
        mkdirSync(dest, { recursive: true });
        cpSync(src, dest, { recursive: true, force: true });
        copied++;
      }
    }

    run(`rm -rf "${tmpClone}"`);
    ok(`${kit} kit ${release} (${copied} dirs)`);
  }

  return true;
}

// Shared download+extract logic for Options 2, 3, 4
async function installFromWorker(targetDir, endpoint, mergeOnly) {
  log("");

  const code = await ask("  Access code: ");
  if (!code.trim()) {
    err("Access code required.");
    return false;
  }

  // Check remote version
  const packName = endpoint.split("/").pop(); // "ck" or "custom"
  info(`Checking version (${packName})...`);
  try {
    const res = await fetch(`${WORKER_URL}/version/${packName}`);
    if (res.status === 200) {
      const v = JSON.parse(res.body);
      log(`  Remote: ${v.sha || "?"} — ${v.message || ""} (${v.updatedAt || ""})`);
    }
  } catch {
    warn("Could not fetch version info — continuing anyway.");
  }

  // Download tarball
  info("Downloading...");
  const tarFile = join(tmpdir(), `skill-${Date.now()}.tar.gz`);
  try {
    await downloadFile(
      `${WORKER_URL}/${endpoint}?key=${encodeURIComponent(code.trim())}`,
      tarFile,
    );
  } catch (e) {
    err(`Download failed: ${e.message}`);
    return false;
  }

  const fileSize = run(`du -h "${tarFile}"`)?.split("\t")[0] || "?";
  ok(`Downloaded (${fileSize})`);

  // Extract — GitHub tarball has a top-level dir (repo-sha/), strip it
  mkdirSync(targetDir, { recursive: true });
  const extractDir = join(tmpdir(), `skill-extract-${Date.now()}`);
  mkdirSync(extractDir, { recursive: true });

  // --strip-components=1 removes the GitHub-generated top-level dir
  run(`tar xzf "${tarFile}" -C "${extractDir}" --strip-components=1`);

  const beforeSkills = countItems(join(targetDir, "skills"));
  const beforeAgents = countItems(join(targetDir, "agents"));

  let newCount = 0;

  for (const dir of KIT_DIRS) {
    const src = join(extractDir, dir);
    if (!existsSync(src)) continue;

    const dest = join(targetDir, dir);
    mkdirSync(dest, { recursive: true });

    if (mergeOnly) {
      const items = readdirSync(src, { withFileTypes: true });
      for (const item of items) {
        const destItem = join(dest, item.name);
        if (!existsSync(destItem)) {
          cpSync(join(src, item.name), destItem, { recursive: true });
          newCount++;
        }
      }
    } else {
      cpSync(src, dest, { recursive: true, force: true });
    }
  }

  const afterSkills = countItems(join(targetDir, "skills"));
  const afterAgents = countItems(join(targetDir, "agents"));

  run(`rm -rf "${tarFile}" "${extractDir}"`);

  if (mergeOnly) {
    const addedSkills = afterSkills - beforeSkills;
    const addedAgents = afterAgents - beforeAgents;
    ok(`Merge: ${beforeSkills} → ${afterSkills} skills (+${addedSkills}), ${beforeAgents} → ${afterAgents} agents (+${addedAgents})`);
  } else {
    ok(`Installed: ${afterSkills} skills, ${afterAgents} agents`);
    if (beforeSkills > 0) log(`  (was: ${beforeSkills} skills, ${beforeAgents} agents)`);
  }

  return true;
}

// ─── Main ──────────────────────────────────────────────────────
async function main() {
  log("\n  Skill Installer\n  ================\n");

  // 1. Platform selection
  const platforms = detectPlatforms();
  log("Install target:");
  platforms.forEach((p, i) => {
    const status = p.detected ? "(detected)" : "(not found)";
    log(`  [${i + 1}] ${p.name} ${status}`);
  });
  log(`  [${platforms.length + 1}] All`);
  log("");

  const platformChoice = await ask("Choose [1]: ");
  const pIdx = parseInt(platformChoice || "1", 10) - 1;

  let targets;
  if (pIdx === platforms.length) {
    targets = platforms;
  } else if (pIdx >= 0 && pIdx < platforms.length) {
    targets = [platforms[pIdx]];
  } else {
    targets = [platforms[0]];
  }

  // 2. Install method
  log("");
  log("Install method:");
  log("  [1] CK Official        — requires gh auth login with CK account");
  log("  [2] CK mirror          — access code required, CK skills only");
  log("  [3] Full skill pack    — access code required, CK + custom skills");
  log("");

  const methodChoice = await ask("Choose [3]: ");
  const method = parseInt(methodChoice || "3", 10);

  // 3. Merge mode (for options 2 & 3)
  let mergeOnly = false;
  if (method === 2 || method === 3) {
    log("");
    log("Install mode:");
    log("  [1] Overwrite all      — replace everything with latest");
    log("  [2] Merge only         — add missing, keep existing");
    log("");
    const modeChoice = await ask("Choose [1]: ");
    mergeOnly = parseInt(modeChoice || "1", 10) === 2;
  }

  // 4. Execute per target
  for (const target of targets) {
    log(`\n${"─".repeat(44)}`);
    log(`  Target: ${target.name}`);
    log(`  Path:   ${target.dir}`);
    log(`${"─".repeat(44)}`);

    let success = false;
    switch (method) {
      case 1:
        success = await installCKOfficial(target.dir);
        break;
      case 2:
        success = await installFromWorker(target.dir, "download/ck", mergeOnly);
        break;
      case 3:
        success = await installFromWorker(target.dir, "download/custom", mergeOnly);
        break;
      default:
        err("Invalid choice.");
    }

    if (!success) warn(`Failed for ${target.name}`);
  }

  // 4. Summary
  log(`\n${"═".repeat(44)}`);
  for (const target of targets) {
    const skills = countItems(join(target.dir, "skills"));
    const agents = countItems(join(target.dir, "agents"));
    const rules = countItems(join(target.dir, "rules"));
    log(`  ${target.name}: ${skills} skills, ${agents} agents, ${rules} rules`);
  }
  log("");
  ok("Setup complete!");
  log("\n  To update later:  npx -y dmdfami/skill\n");

  rl.close();
}

main().catch((e) => {
  console.error(`  XX  Error: ${e.message}`);
  rl.close();
  process.exit(1);
});
