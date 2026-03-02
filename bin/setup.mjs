#!/usr/bin/env node
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, cpSync, readdirSync, readFileSync, writeFileSync, createWriteStream } from "node:fs";
import { homedir, tmpdir, platform } from "node:os";
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
const ok = (msg) => console.log(`\u2705 ${msg}`);
const info = (msg) => console.log(`\ud83d\udce6 ${msg}`);
const warn = (msg) => console.log(`\u26a0\ufe0f  ${msg}`);
const err = (msg) => console.log(`\u274c ${msg}`);

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
        res.on("end", () => reject(new Error(Buffer.concat(chunks).toString())));
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
  const platforms = [];
  const home = homedir();

  // Claude Code CLI
  const claudeDir = join(home, ".claude");
  if (existsSync(claudeDir)) {
    platforms.push({ name: "Claude Code", dir: claudeDir, detected: true });
  } else {
    platforms.push({ name: "Claude Code", dir: claudeDir, detected: false });
  }

  // Codex CLI (OpenAI) — check common locations
  const codexPaths = [
    join(home, ".codex"),
    join(home, ".config", "codex"),
    join(home, "AppData", "Roaming", "codex"),
  ];
  for (const p of codexPaths) {
    if (existsSync(p)) {
      platforms.push({ name: "Codex CLI", dir: p, detected: true });
      break;
    }
  }
  if (!platforms.find((p) => p.name === "Codex CLI")) {
    platforms.push({ name: "Codex CLI", dir: join(home, ".codex"), detected: false });
  }

  return platforms;
}

// ─── Install Methods ───────────────────────────────────────────

async function installCKOfficial(targetDir) {
  log("");
  info("Option 1: CK Official Install");
  log("  Requires: gh auth login (GitHub account with CK access)");
  log("");

  // Check gh
  const ghVersion = run("gh --version");
  if (!ghVersion) {
    err("GitHub CLI (gh) not found. Install: https://cli.github.com/");
    return false;
  }
  ok(`GitHub CLI: ${ghVersion.split("\n")[0]}`);

  // Check auth
  const ghAuth = run("gh auth status 2>&1");
  if (!ghAuth || ghAuth.includes("not logged")) {
    err("Not authenticated. Run: gh auth login");
    return false;
  }
  ok("GitHub authenticated");

  // Check/install ck CLI
  const ckVersion = run("ck --version 2>/dev/null");
  if (ckVersion) {
    ok(`claudekit-cli ${ckVersion}`);
  } else {
    info("Installing claudekit-cli...");
    run("npm install -g claudekit-cli", { stdio: "inherit" });
  }

  // Clone each kit
  mkdirSync(targetDir, { recursive: true });
  for (const { name: kit, repo } of CK_KITS) {
    log("");
    info(`Fetching ${kit} kit...`);

    // Get latest tag
    const tagsRaw = run(`gh api repos/${repo}/tags --jq '.[0].name' 2>/dev/null`);
    const release = tagsRaw || "main";
    info(`Version: ${release}`);

    // Clone to temp
    const tmpClone = join(tmpdir(), `ck-${kit}-${Date.now()}`);
    const cloneCmd = `gh repo clone ${repo} "${tmpClone}" -- --depth=1 --branch ${release}`;
    const result = run(cloneCmd, { timeout: 120000 });

    if (result === null && !existsSync(join(tmpClone, ".claude"))) {
      warn(`${kit} clone failed. Check GitHub access.`);
      continue;
    }

    // Copy kit directories
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
    ok(`${kit} kit ${release} (${copied} directories)`);
  }

  return true;
}

async function installFromR2(targetDir, mergeOnly) {
  log("");
  info("Option 2: Private Download");
  log("");

  const code = await ask("  Access code: ");
  if (!code.trim()) {
    err("Access code required.");
    return false;
  }

  // Check remote version
  info("Checking version...");
  let remoteVersion;
  try {
    const res = await fetch(`${WORKER_URL}/version`);
    remoteVersion = JSON.parse(res.body);
    log(`  Remote: v${remoteVersion.version} (${remoteVersion.skills} skills)`);
  } catch {
    err("Cannot reach server.");
    return false;
  }

  // Check local version
  const localVersionFile = join(targetDir, ".skill-version");
  let localVersion = "0.0.0";
  if (existsSync(localVersionFile)) {
    localVersion = readFileSync(localVersionFile, "utf8").trim();
    log(`  Local:  v${localVersion}`);
  } else {
    log("  Local:  not installed");
  }

  if (localVersion === remoteVersion.version) {
    ok("Already up to date.");
    const ans = await ask("  Force reinstall? [y/N] ");
    if (ans.toLowerCase() !== "y") return true;
  }

  // Download
  info("Downloading...");
  const tarFile = join(tmpdir(), `skill-${Date.now()}.tar.gz`);
  try {
    await downloadFile(
      `${WORKER_URL}/download?key=${encodeURIComponent(code.trim())}`,
      tarFile,
    );
  } catch (e) {
    err(`Download failed: ${e.message}`);
    return false;
  }

  const fileSize = run(`du -h "${tarFile}"`)?.split("\t")[0] || "?";
  ok(`Downloaded (${fileSize})`);

  // Extract
  mkdirSync(targetDir, { recursive: true });
  const extractDir = join(tmpdir(), `skill-extract-${Date.now()}`);
  mkdirSync(extractDir, { recursive: true });

  run(`tar xzf "${tarFile}" -C "${extractDir}"`);

  // Count before install
  const beforeSkills = countItems(join(targetDir, "skills"));
  const beforeAgents = countItems(join(targetDir, "agents"));

  // Copy/merge
  let newCount = 0;
  let updatedCount = 0;

  for (const dir of KIT_DIRS) {
    const src = join(extractDir, dir);
    if (!existsSync(src)) continue;

    const dest = join(targetDir, dir);
    mkdirSync(dest, { recursive: true });

    if (mergeOnly) {
      // Only copy items that don't exist locally
      const items = readdirSync(src, { withFileTypes: true });
      for (const item of items) {
        const destItem = join(dest, item.name);
        if (!existsSync(destItem)) {
          const srcItem = join(src, item.name);
          cpSync(srcItem, destItem, { recursive: true });
          newCount++;
        }
      }
    } else {
      // Full overwrite
      cpSync(src, dest, { recursive: true, force: true });
    }
  }

  // Count after install
  const afterSkills = countItems(join(targetDir, "skills"));
  const afterAgents = countItems(join(targetDir, "agents"));

  // Save version
  writeFileSync(localVersionFile, remoteVersion.version);

  // Cleanup
  run(`rm -rf "${tarFile}" "${extractDir}"`);

  if (mergeOnly) {
    ok(`Merge complete: ${newCount} new items added`);
  } else {
    ok(`Installed: ${afterSkills} skills, ${afterAgents} agents`);
    if (beforeSkills > 0) {
      log(`  (was: ${beforeSkills} skills, ${beforeAgents} agents)`);
    }
  }

  return true;
}

// ─── Main ──────────────────────────────────────────────────────
async function main() {
  log("\n\ud83d\udd27 Skill Installer\n==================\n");

  // 1. Platform selection
  const platforms = detectPlatforms();
  log("Install target:");
  platforms.forEach((p, i) => {
    const status = p.detected ? "(detected)" : "(not found)";
    log(`  [${i + 1}] ${p.name} ${status}`);
  });
  if (platforms.length > 1) {
    log(`  [${platforms.length + 1}] All platforms`);
  }
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
  log("  [1] CK Official (requires gh auth login with CK account)");
  log("  [2] Private download (access code required)");
  log("  [3] Private download — merge only (add missing skills)");
  log("");

  const methodChoice = await ask("Choose [2]: ");
  const method = parseInt(methodChoice || "2", 10);

  // 3. Execute
  for (const target of targets) {
    log(`\n${"─".repeat(40)}`);
    log(`Target: ${target.name} (${target.dir})`);
    log(`${"─".repeat(40)}`);

    let success = false;
    switch (method) {
      case 1:
        success = await installCKOfficial(target.dir);
        break;
      case 2:
        success = await installFromR2(target.dir, false);
        break;
      case 3:
        success = await installFromR2(target.dir, true);
        break;
      default:
        err("Invalid method.");
    }

    if (!success) {
      warn(`Failed for ${target.name}`);
    }
  }

  // 4. Summary
  log(`\n${"═".repeat(40)}`);
  for (const target of targets) {
    const skills = countItems(join(target.dir, "skills"));
    const agents = countItems(join(target.dir, "agents"));
    const rules = countItems(join(target.dir, "rules"));
    log(`${target.name}: ${skills} skills, ${agents} agents, ${rules} rules`);
  }
  log("");
  ok("Setup complete!\n");
  log("To update later, run:");
  log("  npx dmdfami/skill\n");

  rl.close();
}

main().catch((e) => {
  console.error(`\u274c Error: ${e.message}`);
  rl.close();
  process.exit(1);
});
