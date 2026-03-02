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

// ─── ANSI Colors ───────────────────────────────────────────────
const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
  blue: '\x1b[34m',
  white: '\x1b[37m',
  bgCyan: '\x1b[46m',
  bgBlue: '\x1b[44m',
};

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
const ok = (msg) => console.log(`  ${c.green}✓${c.reset} ${msg}`);
const info = (msg) => console.log(`  ${c.cyan}▸${c.reset} ${msg}`);
const warn = (msg) => console.log(`  ${c.yellow}⚠${c.reset}  ${msg}`);
const err = (msg) => console.log(`  ${c.red}✗${c.reset} ${msg}`);

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
        res.on("data", (ch) => chunks.push(ch));
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
  info(`CK Official Install ${c.dim}— requires gh auth login with CK account${c.reset}`);
  log("");

  const ghVersion = run("gh --version");
  if (!ghVersion) {
    err("GitHub CLI (gh) not found. Install: https://cli.github.com/");
    return false;
  }
  ok(`GitHub CLI: ${c.dim}${ghVersion.split("\n")[0]}${c.reset}`);

  const ghAuth = run("gh auth status 2>&1");
  if (!ghAuth || ghAuth.includes("not logged")) {
    err("Not authenticated. Run: gh auth login");
    return false;
  }
  ok("GitHub authenticated");

  mkdirSync(targetDir, { recursive: true });

  for (const { name: kit, repo } of CK_KITS) {
    log("");
    info(`Fetching ${c.bold}${kit}${c.reset} kit...`);

    const tagsRaw = run(`gh api repos/${repo}/tags --jq '.[0].name' 2>/dev/null`);
    const release = tagsRaw || "main";
    info(`Version: ${c.cyan}${release}${c.reset}`);

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
    ok(`${c.bold}${kit}${c.reset} kit ${c.cyan}${release}${c.reset} ${c.dim}(${copied} dirs)${c.reset}`);
  }

  return true;
}

// Shared download+extract logic for option 2
async function installFromWorker(targetDir, mergeOnly) {
  log("");

  const code = await ask(`  ${c.cyan}🔑${c.reset} Access code: `);
  if (!code.trim()) {
    err("Access code required.");
    return false;
  }

  // Check remote version
  info("Checking version...");
  try {
    const res = await fetch(`${WORKER_URL}/version/custom`);
    if (res.status === 200) {
      const v = JSON.parse(res.body);
      log(`  ${c.dim}Remote: ${v.sha || "?"} — ${v.message || ""} (${v.updatedAt || ""})${c.reset}`);
    }
  } catch {
    warn("Could not fetch version info — continuing anyway.");
  }

  // Download tarball
  info("Downloading...");
  const tarFile = join(tmpdir(), `skill-${Date.now()}.tar.gz`);
  try {
    await downloadFile(
      `${WORKER_URL}/download/custom?key=${encodeURIComponent(code.trim())}`,
      tarFile,
    );
  } catch (e) {
    err(`Download failed: ${e.message}`);
    return false;
  }

  const fileSize = run(`du -h "${tarFile}"`)?.split("\t")[0] || "?";
  ok(`Downloaded ${c.dim}(${fileSize})${c.reset}`);

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
    ok(`Merge: ${beforeSkills} → ${c.green}${afterSkills}${c.reset} skills ${c.dim}(+${addedSkills})${c.reset}, ${beforeAgents} → ${c.green}${afterAgents}${c.reset} agents ${c.dim}(+${addedAgents})${c.reset}`);
  } else {
    ok(`Installed: ${c.bold}${afterSkills}${c.reset} skills, ${c.bold}${afterAgents}${c.reset} agents`);
    if (beforeSkills > 0) log(`  ${c.dim}(was: ${beforeSkills} skills, ${beforeAgents} agents)${c.reset}`);
  }

  return true;
}

// ─── Main ──────────────────────────────────────────────────────
async function main() {
  log("");
  log(`  ${c.bold}${c.cyan}╔══════════════════════════════════════╗${c.reset}`);
  log(`  ${c.bold}${c.cyan}║${c.reset}  ${c.bold}⚡ Skill Installer${c.reset}                  ${c.bold}${c.cyan}║${c.reset}`);
  log(`  ${c.bold}${c.cyan}╚══════════════════════════════════════╝${c.reset}`);
  log("");

  // 1. Platform selection
  const platforms = detectPlatforms();
  log(`  ${c.bold}Install target:${c.reset}`);
  log("");
  platforms.forEach((p, i) => {
    const status = p.detected
      ? `${c.green}● detected${c.reset}`
      : `${c.dim}○ not found${c.reset}`;
    log(`  ${c.cyan}${c.bold}[${i + 1}]${c.reset} ${c.bold}${c.white}${p.name}${c.reset}  ${status}`);
  });
  log(`  ${c.cyan}${c.bold}[${platforms.length + 1}]${c.reset} ${c.bold}${c.white}All${c.reset}`);
  log("");

  const platformChoice = await ask(`  ${c.cyan}❯${c.reset} Choose ${c.dim}[1]${c.reset}: `);
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
  log(`  ${c.bold}Install method:${c.reset}`);
  log("");
  log(`  ${c.cyan}${c.bold}[1]${c.reset} ${c.bold}${c.white}CK Official${c.reset}      ${c.dim}requires gh auth login with CK account${c.reset}`);
  log(`  ${c.cyan}${c.bold}[2]${c.reset} ${c.bold}${c.white}Full skill pack${c.reset}  ${c.dim}access code required, CK + custom skills${c.reset}`);
  log("");

  const methodChoice = await ask(`  ${c.cyan}❯${c.reset} Choose ${c.dim}[2]${c.reset}: `);
  const method = parseInt(methodChoice || "2", 10);

  // 3. Merge mode (for option 2)
  let mergeOnly = false;
  if (method === 2) {
    log("");
    log(`  ${c.bold}Install mode:${c.reset}`);
    log("");
    log(`  ${c.cyan}${c.bold}[1]${c.reset} ${c.bold}${c.white}Overwrite all${c.reset}  ${c.dim}replace everything with latest${c.reset}`);
    log(`  ${c.cyan}${c.bold}[2]${c.reset} ${c.bold}${c.white}Merge only${c.reset}     ${c.dim}add missing, keep existing${c.reset}`);
    log("");
    const modeChoice = await ask(`  ${c.cyan}❯${c.reset} Choose ${c.dim}[1]${c.reset}: `);
    mergeOnly = parseInt(modeChoice || "1", 10) === 2;
  }

  // 4. Execute per target
  for (const target of targets) {
    log("");
    log(`  ${c.dim}┌──────────────────────────────────────┐${c.reset}`);
    log(`  ${c.dim}│${c.reset}  ${c.bold}Target:${c.reset} ${target.name.padEnd(28)}${c.dim}│${c.reset}`);
    log(`  ${c.dim}│${c.reset}  ${c.bold}Path:${c.reset}   ${c.dim}${target.dir.padEnd(28)}${c.reset}${c.dim}│${c.reset}`);
    log(`  ${c.dim}└──────────────────────────────────────┘${c.reset}`);

    let success = false;
    switch (method) {
      case 1:
        success = await installCKOfficial(target.dir);
        break;
      case 2:
        success = await installFromWorker(target.dir, mergeOnly);
        break;
      default:
        err("Invalid choice.");
    }

    if (!success) warn(`Failed for ${target.name}`);
  }

  // 5. Summary
  log("");
  log(`  ${c.bold}${c.cyan}╔══════════════════════════════════════╗${c.reset}`);
  for (const target of targets) {
    const skills = countItems(join(target.dir, "skills"));
    const agents = countItems(join(target.dir, "agents"));
    const rules = countItems(join(target.dir, "rules"));
    const line = `${target.name}: ${skills} skills, ${agents} agents, ${rules} rules`;
    log(`  ${c.bold}${c.cyan}║${c.reset}  ${c.bold}${line.padEnd(36)}${c.reset}${c.bold}${c.cyan}║${c.reset}`);
  }
  log(`  ${c.bold}${c.cyan}╚══════════════════════════════════════╝${c.reset}`);
  log("");
  ok(`${c.bold}Setup complete!${c.reset}`);
  log(`\n  ${c.dim}To update later:  npx -y dmdfami/skill${c.reset}\n`);

  rl.close();
}

main().catch((e) => {
  console.error(`  ${c.red}✗${c.reset} Error: ${e.message}`);
  rl.close();
  process.exit(1);
});
