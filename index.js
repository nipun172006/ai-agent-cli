import "dotenv/config";
import axios from "axios";
import OpenAI from "openai";
import { exec } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execAsync = promisify(exec);
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || process.env.MEGALLM_API_KEY || process.env.API_KEY,
  baseURL: process.env.OPENAI_BASE_URL,
});

const ROOT_DIR = process.cwd();
const MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const MAX_AGENT_STEPS = Number(process.env.MAX_AGENT_STEPS || 24);
const DEMO_MODE = process.env.DEMO_MODE === "true";

const colors = {
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  gray: "\x1b[90m",
  magenta: "\x1b[35m",
  red: "\x1b[31m",
  reset: "\x1b[0m",
  yellow: "\x1b[33m",
};

const systemPrompt = `
You are a terminal-based AI coding agent.

You must solve user tasks through a visible agent loop with these steps:
START, THINK, TOOL, OBSERVE, OUTPUT.

Rules:
1. Always reply with exactly one JSON object. Do not use markdown.
2. Use this schema:
   { "step": "START | THINK | TOOL | OBSERVE | OUTPUT", "content": "string", "tool_name": "string", "tool_args": "string" }
3. Do one step at a time.
4. Use concise THINK messages that explain the next practical action. Do not reveal private chain-of-thought.
5. After a TOOL step, wait for the OBSERVE message before continuing.
6. Use tools to create real folders and files when the user asks for code or websites.
7. For a Scaler Academy website clone request, always:
   - START the task.
   - THINK about the required sections.
   - call executeCommand with "mkdir -p scaler-academy-clone".
   - after OBSERVE, THINK again.
   - call createScalerCloneWebsite with {"folderName":"scaler-academy-clone"}.
   - after OBSERVE, OUTPUT the created file paths and how to open index.html.

Available tools:
1. getTheWeatherOfCity(cityname: string): fetches live weather for a city.
2. getGithubDetailsAboutUser(username: string): fetches public GitHub profile details.
3. executeCommand(cmd: string): executes a safe shell command in the current project directory. It can create folders and files.
4. writeFile({"path":"relative/path","content":"text"}): writes a UTF-8 file inside the project.
5. createScalerCloneWebsite({"folderName":"scaler-academy-clone"}): creates index.html, style.css, and script.js for a Scaler Academy inspired clone.
`.trim();

function hasValidApiKey() {
  const key = process.env.OPENAI_API_KEY || process.env.MEGALLM_API_KEY || process.env.API_KEY;
  const placeholders = new Set(["your_api_key_here", "sk-your-key-here"]);
  return Boolean(key && key.trim() && !placeholders.has(key.trim()));
}

function isScalerCloneRequest(inputText) {
  return /scaler/i.test(inputText) && /(clone|website|webpage|page|academy)/i.test(inputText);
}

function isQuotaError(error) {
  return error?.status === 429 || error?.status === 402 || /quota|billing|credits|rate limit/i.test(error?.message || "");
}

function colorize(value, colorName) {
  return `${colors[colorName] || ""}${value}${colors.reset}`;
}

function safeJsonParse(content) {
  try {
    return JSON.parse(content);
  } catch {
    const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) {
      return JSON.parse(fenced[1]);
    }

    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      return JSON.parse(content.slice(start, end + 1));
    }

    throw new Error("Model did not return valid JSON.");
  }
}

function parseToolArgs(rawArgs) {
  if (rawArgs === undefined || rawArgs === null) {
    return "";
  }

  if (typeof rawArgs !== "string") {
    return rawArgs;
  }

  const trimmed = rawArgs.trim();
  if (!trimmed) {
    return "";
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function getStringArg(rawArgs, keys = []) {
  const parsed = parseToolArgs(rawArgs);

  if (typeof parsed === "string") {
    return parsed;
  }

  if (parsed && typeof parsed === "object") {
    for (const key of keys) {
      if (typeof parsed[key] === "string") {
        return parsed[key];
      }
    }
  }

  return "";
}

function resolveInsideWorkspace(relativePath) {
  if (!relativePath || typeof relativePath !== "string") {
    throw new Error("A relative path is required.");
  }

  if (path.isAbsolute(relativePath)) {
    throw new Error("Only relative paths inside this project are allowed.");
  }

  const resolved = path.resolve(ROOT_DIR, relativePath);
  const rootWithSeparator = ROOT_DIR.endsWith(path.sep) ? ROOT_DIR : `${ROOT_DIR}${path.sep}`;

  if (resolved !== ROOT_DIR && !resolved.startsWith(rootWithSeparator)) {
    throw new Error("Path escapes the project directory.");
  }

  return resolved;
}

function assertSafeCommand(command) {
  const blockedPatterns = [
    { pattern: /\brm\s+(-[^\s]*r|--recursive)\b/i, reason: "recursive deletion is blocked" },
    { pattern: /\bgit\s+reset\s+--hard\b/i, reason: "destructive git reset is blocked" },
    { pattern: /\bsudo\b/i, reason: "sudo commands are blocked" },
    { pattern: /\bchmod\s+777\b/i, reason: "wide-open chmod is blocked" },
    { pattern: /\b(chown|shutdown|reboot|mkfs)\b/i, reason: "system-level commands are blocked" },
    { pattern: /(^|\s)cd\s+\.\.(\s|$)/i, reason: "changing outside the project is blocked" },
    { pattern: /\.\.\//, reason: "paths outside the project are blocked" },
    { pattern: /(^|\s)>\s*(\/|~)/, reason: "writing outside the project is blocked" },
  ];

  for (const { pattern, reason } of blockedPatterns) {
    if (pattern.test(command)) {
      throw new Error(`Unsafe command rejected: ${reason}.`);
    }
  }
}

async function getTheWeatherOfCity(rawArgs = "") {
  const cityName = getStringArg(rawArgs, ["city", "cityname", "cityName"]).trim();
  if (!cityName) {
    throw new Error("City name is required.");
  }

  const url = `https://wttr.in/${encodeURIComponent(cityName.toLowerCase())}?format=%C+%t`;
  const { data } = await axios.get(url, { responseType: "text" });
  return `The weather of ${cityName} is ${data}`;
}

async function getGithubDetailsAboutUser(rawArgs = "") {
  const username = getStringArg(rawArgs, ["username", "user"]).trim();
  if (!username) {
    throw new Error("GitHub username is required.");
  }

  const url = `https://api.github.com/users/${encodeURIComponent(username)}`;
  const { data } = await axios.get(url);

  return JSON.stringify(
    {
      login: data.login,
      name: data.name,
      blog: data.blog,
      public_repos: data.public_repos,
      profile: data.html_url,
    },
    null,
    2,
  );
}

async function executeCommand(rawArgs = "") {
  const command = getStringArg(rawArgs, ["cmd", "command"]).trim();
  if (!command) {
    throw new Error("Command is required.");
  }

  assertSafeCommand(command);

  const { stdout, stderr } = await execAsync(command, {
    cwd: ROOT_DIR,
    maxBuffer: 1024 * 1024,
    timeout: 30_000,
  });

  const outputText = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
  return outputText || `Command completed successfully: ${command}`;
}

async function writeFile(rawArgs = "") {
  const args = parseToolArgs(rawArgs);
  if (!args || typeof args !== "object") {
    throw new Error('writeFile expects {"path":"relative/path","content":"text"}.');
  }

  const targetPath = resolveInsideWorkspace(args.path);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, String(args.content || ""), "utf8");

  const relative = path.relative(ROOT_DIR, targetPath);
  return `Wrote ${relative}`;
}

async function createScalerCloneWebsite(rawArgs = "") {
  const args = parseToolArgs(rawArgs);
  const folderName =
    typeof args === "string"
      ? args || "scaler-academy-clone"
      : args?.folderName || args?.folder || "scaler-academy-clone";

  if (String(folderName).includes("..")) {
    throw new Error("Folder name cannot contain '..'.");
  }

  const outputDir = resolveInsideWorkspace(String(folderName));
  await fs.mkdir(outputDir, { recursive: true });

  const files = {
    "index.html": buildScalerHtml(),
    "style.css": buildScalerCss(),
    "script.js": buildScalerJs(),
  };

  await Promise.all(
    Object.entries(files).map(([fileName, content]) =>
      fs.writeFile(path.join(outputDir, fileName), content, "utf8"),
    ),
  );

  const createdFiles = Object.keys(files).map((fileName) =>
    path.relative(ROOT_DIR, path.join(outputDir, fileName)),
  );

  return `Created Scaler Academy inspired website files:\n${createdFiles.join("\n")}`;
}

function buildScalerHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Scaler Academy Clone</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="./style.css">
</head>
<body>
  <header class="site-header">
    <nav class="nav" aria-label="Primary navigation">
      <a class="brand" href="#top" aria-label="Scaler home">
        <span class="brand-mark">S</span>
        <span>Scaler</span>
      </a>

      <button class="nav-toggle" type="button" aria-label="Toggle menu" aria-expanded="false">
        <span></span>
        <span></span>
        <span></span>
      </button>

      <div class="nav-links">
        <a href="#programs">Programs</a>
        <a href="#curriculum">Curriculum</a>
        <a href="#mentors">Mentors</a>
        <a href="#outcomes">Outcomes</a>
      </div>

      <button class="nav-cta" type="button" data-callback>Request callback</button>
    </nav>
  </header>

  <main id="top">
    <section class="hero">
      <div class="hero-pattern" aria-hidden="true"></div>
      <div class="container hero-inner">
        <p class="eyebrow">AI-ready career acceleration</p>
        <h1>Become the professional built for the next decade in tech.</h1>
        <p class="hero-text">
          Master software engineering, data, cloud, and AI with structured live learning, expert mentorship,
          real projects, and career support inspired by Scaler Academy.
        </p>
        <div class="hero-actions" aria-label="Primary actions">
          <button class="primary-btn" type="button" data-callback>Talk to an advisor</button>
          <a class="secondary-btn" href="#programs">Explore programs</a>
        </div>

        <div class="hero-proof" aria-label="Learner outcomes">
          <div><strong>25K+</strong><span>learner ratings</span></div>
          <div><strong>1:1</strong><span>mentor guidance</span></div>
          <div><strong>24/7</strong><span>learning support</span></div>
        </div>
      </div>

      <div class="hero-dashboard" aria-label="Program highlights">
        <div class="dashboard-top">
          <span></span>
          <span></span>
          <span></span>
        </div>
        <div class="dashboard-grid">
          <article>
            <small>Module 01</small>
            <strong>DSA Foundations</strong>
            <div class="progress"><span style="width: 88%"></span></div>
          </article>
          <article>
            <small>Module 02</small>
            <strong>AI Pair Labs</strong>
            <div class="progress"><span style="width: 74%"></span></div>
          </article>
          <article>
            <small>Career Track</small>
            <strong>Mock Interviews</strong>
            <div class="progress"><span style="width: 92%"></span></div>
          </article>
        </div>
      </div>
    </section>

    <section class="section intro-band">
      <div class="container split">
        <div>
          <p class="section-kicker">Built different, designed to last</p>
          <h2>Everything a working professional needs to move into better tech roles.</h2>
        </div>
        <p>
          The experience combines deep fundamentals, AI-assisted practice, live classes, mentor reviews,
          and a practical roadmap that keeps pace with the market.
        </p>
      </div>
    </section>

    <section class="section" id="programs">
      <div class="container">
        <div class="section-heading">
          <p class="section-kicker">Programs</p>
          <h2>Find the right AI path for your role.</h2>
        </div>

        <div class="program-grid">
          <article class="program-card is-active">
            <span class="card-tag">Software</span>
            <h3>Modern Software and AI Engineering</h3>
            <p>DSA, system design, backend architecture, projects, and AI workflows for product teams.</p>
            <button type="button">Explore track</button>
          </article>
          <article class="program-card">
            <span class="card-tag">Data</span>
            <h3>Data Science and ML with AI</h3>
            <p>Statistics, ML systems, model evaluation, analytics storytelling, and applied AI projects.</p>
            <button type="button">Explore track</button>
          </article>
          <article class="program-card">
            <span class="card-tag">Cloud</span>
            <h3>DevOps, Cloud and Platform Engineering</h3>
            <p>Cloud infrastructure, CI/CD, observability, containers, automation, and platform thinking.</p>
            <button type="button">Explore track</button>
          </article>
        </div>
      </div>
    </section>

    <section class="section curriculum" id="curriculum">
      <div class="container">
        <div class="section-heading">
          <p class="section-kicker">Curriculum</p>
          <h2>Structured learning with real accountability.</h2>
        </div>

        <div class="timeline">
          <div class="timeline-item">
            <span>01</span>
            <div>
              <h3>Programming foundations</h3>
              <p>Time complexity, arrays, recursion, object-oriented design, and clean problem solving.</p>
            </div>
          </div>
          <div class="timeline-item">
            <span>02</span>
            <div>
              <h3>Data structures and algorithms</h3>
              <p>Trees, graphs, dynamic programming, heaps, hashing, and interview-style practice.</p>
            </div>
          </div>
          <div class="timeline-item">
            <span>03</span>
            <div>
              <h3>System design and projects</h3>
              <p>Scalable services, databases, caching, APIs, real-world builds, and architecture reviews.</p>
            </div>
          </div>
          <div class="timeline-item">
            <span>04</span>
            <div>
              <h3>Career support</h3>
              <p>Mock interviews, profile building, mentor feedback, and job-readiness coaching.</p>
            </div>
          </div>
        </div>
      </div>
    </section>

    <section class="section mentors" id="mentors">
      <div class="container split">
        <div>
          <p class="section-kicker">Mentorship</p>
          <h2>Learn from engineers who have built at top technology companies.</h2>
          <p>
            Weekly mentor sessions, TA support, and guided reviews help learners convert effort into progress.
          </p>
        </div>
        <div class="mentor-list">
          <article>
            <strong>Industry mentors</strong>
            <span>Architecture, interviews, and career direction</span>
          </article>
          <article>
            <strong>Teaching assistants</strong>
            <span>Doubt solving and assignment support</span>
          </article>
          <article>
            <strong>Career coaches</strong>
            <span>Mock interviews and hiring preparation</span>
          </article>
        </div>
      </div>
    </section>

    <section class="section outcomes" id="outcomes">
      <div class="container">
        <div class="section-heading">
          <p class="section-kicker">Outcomes</p>
          <h2>Proof matters more than promises.</h2>
        </div>

        <div class="stats-grid">
          <article><strong>4.8+</strong><span>average learner rating</span></article>
          <article><strong>600+</strong><span>hiring partners</span></article>
          <article><strong>12 mo</strong><span>guided learning path</span></article>
          <article><strong>Live</strong><span>classes and projects</span></article>
        </div>
      </div>
    </section>

    <section class="section final-cta">
      <div class="container">
        <p class="section-kicker">Start your next chapter</p>
        <h2>Ready to build skills that compound?</h2>
        <button class="primary-btn" type="button" data-callback>Request callback</button>
      </div>
    </section>
  </main>

  <footer class="site-footer">
    <div class="container footer-grid">
      <div>
        <a class="brand footer-brand" href="#top">
          <span class="brand-mark">S</span>
          <span>Scaler</span>
        </a>
        <p>Educational Scaler Academy inspired clone generated by an AI CLI agent.</p>
      </div>
      <div>
        <h3>Explore</h3>
        <a href="#programs">Programs</a>
        <a href="#curriculum">Curriculum</a>
        <a href="#mentors">Mentors</a>
      </div>
      <div>
        <h3>Resources</h3>
        <a href="#outcomes">Reviews</a>
        <a href="#outcomes">Career outcomes</a>
        <a href="#top">Contact</a>
      </div>
      <div>
        <h3>Social</h3>
        <a href="https://www.scaler.com/" target="_blank" rel="noreferrer">Official Scaler</a>
        <a href="#top">LinkedIn</a>
        <a href="#top">YouTube</a>
      </div>
    </div>
    <div class="container footer-bottom">
      <span>Made for Assignment 02</span>
      <span id="year"></span>
    </div>
  </footer>

  <script src="./script.js"></script>
</body>
</html>
`;
}

function buildScalerCss() {
  return `:root {
  --ink: #102033;
  --muted: #64748b;
  --blue: #1263ff;
  --blue-dark: #0c48c8;
  --mint: #12b981;
  --amber: #f6b443;
  --coral: #ff725e;
  --paper: #ffffff;
  --soft: #f4f7fb;
  --line: #d9e3f0;
  --night: #07111f;
  --shadow: 0 22px 70px rgba(15, 35, 70, 0.16);
}

* {
  box-sizing: border-box;
}

html {
  scroll-behavior: smooth;
}

body {
  margin: 0;
  font-family: "Inter", Arial, sans-serif;
  color: var(--ink);
  background: var(--paper);
  letter-spacing: 0;
}

a {
  color: inherit;
  text-decoration: none;
}

button {
  font: inherit;
}

.container {
  width: min(1120px, calc(100% - 40px));
  margin: 0 auto;
}

.site-header {
  position: sticky;
  top: 0;
  z-index: 20;
  background: rgba(255, 255, 255, 0.92);
  border-bottom: 1px solid rgba(217, 227, 240, 0.8);
  backdrop-filter: blur(18px);
}

.nav {
  width: min(1180px, calc(100% - 32px));
  min-height: 76px;
  margin: 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
}

.brand {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  font-size: 1.25rem;
  font-weight: 800;
}

.brand-mark {
  width: 36px;
  height: 36px;
  border-radius: 8px;
  display: grid;
  place-items: center;
  color: #fff;
  background: var(--blue);
  box-shadow: 0 10px 24px rgba(18, 99, 255, 0.28);
}

.nav-links {
  display: flex;
  align-items: center;
  gap: 28px;
  color: #334155;
  font-size: 0.95rem;
  font-weight: 600;
}

.nav-links a:hover {
  color: var(--blue);
}

.nav-cta,
.primary-btn,
.secondary-btn,
.program-card button {
  min-height: 44px;
  border-radius: 8px;
  border: 0;
  cursor: pointer;
  font-weight: 800;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: transform 180ms ease, box-shadow 180ms ease, background 180ms ease;
}

.nav-cta,
.primary-btn {
  color: #fff;
  background: var(--blue);
  padding: 0 20px;
  box-shadow: 0 14px 28px rgba(18, 99, 255, 0.24);
}

.nav-cta:hover,
.primary-btn:hover,
.program-card button:hover {
  background: var(--blue-dark);
  transform: translateY(-2px);
}

.secondary-btn {
  color: var(--ink);
  background: #fff;
  border: 1px solid rgba(255, 255, 255, 0.38);
  padding: 0 20px;
}

.secondary-btn:hover {
  transform: translateY(-2px);
}

.nav-toggle {
  display: none;
  width: 44px;
  height: 44px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #fff;
  padding: 10px;
}

.nav-toggle span {
  display: block;
  width: 100%;
  height: 2px;
  margin: 5px 0;
  background: var(--ink);
}

.hero {
  position: relative;
  min-height: 720px;
  overflow: hidden;
  color: #fff;
  background:
    linear-gradient(135deg, rgba(7, 17, 31, 0.96), rgba(16, 32, 51, 0.9)),
    linear-gradient(90deg, #102033, #1263ff);
}

.hero-pattern {
  position: absolute;
  inset: 0;
  opacity: 0.24;
  background-image:
    linear-gradient(rgba(255,255,255,0.1) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255,255,255,0.1) 1px, transparent 1px);
  background-size: 48px 48px;
}

.hero-inner {
  position: relative;
  z-index: 2;
  padding: 120px 0 90px;
  max-width: 780px;
  margin-left: calc((100% - min(1120px, calc(100% - 40px))) / 2);
}

.eyebrow,
.section-kicker {
  margin: 0 0 14px;
  color: var(--amber);
  font-size: 0.78rem;
  font-weight: 800;
  text-transform: uppercase;
}

.hero h1 {
  max-width: 760px;
  margin: 0;
  font-size: clamp(2.8rem, 7vw, 5.8rem);
  line-height: 0.98;
  letter-spacing: 0;
}

.hero-text {
  max-width: 690px;
  margin: 24px 0 0;
  color: #d7e4f6;
  font-size: 1.16rem;
  line-height: 1.75;
}

.hero-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  margin-top: 34px;
}

.hero-actions .primary-btn,
.hero-actions .secondary-btn {
  min-height: 52px;
  padding: 0 24px;
}

.hero-proof {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px;
  width: min(660px, 100%);
  margin-top: 52px;
}

.hero-proof div {
  padding: 18px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.08);
}

.hero-proof strong {
  display: block;
  font-size: 1.9rem;
  line-height: 1;
}

.hero-proof span {
  display: block;
  margin-top: 7px;
  color: #cbd7ea;
  font-size: 0.9rem;
}

.hero-dashboard {
  position: absolute;
  right: max(24px, calc((100% - 1180px) / 2));
  bottom: 62px;
  z-index: 2;
  width: min(420px, 36vw);
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.1);
  box-shadow: 0 30px 90px rgba(0, 0, 0, 0.26);
  backdrop-filter: blur(18px);
}

.dashboard-top {
  display: flex;
  gap: 8px;
  padding: 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.14);
}

.dashboard-top span {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--coral);
}

.dashboard-top span:nth-child(2) {
  background: var(--amber);
}

.dashboard-top span:nth-child(3) {
  background: var(--mint);
}

.dashboard-grid {
  display: grid;
  gap: 14px;
  padding: 18px;
}

.dashboard-grid article {
  padding: 16px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.12);
}

.dashboard-grid small {
  display: block;
  color: #b7c7df;
  font-weight: 700;
}

.dashboard-grid strong {
  display: block;
  margin-top: 8px;
}

.progress {
  height: 8px;
  margin-top: 16px;
  overflow: hidden;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.18);
}

.progress span {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--mint);
}

.section {
  padding: 92px 0;
}

.intro-band {
  background: var(--soft);
}

.split {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(280px, 0.78fr);
  gap: 56px;
  align-items: center;
}

.section h2 {
  margin: 0;
  font-size: clamp(2rem, 4vw, 3.45rem);
  line-height: 1.08;
  letter-spacing: 0;
}

.section p {
  color: var(--muted);
  font-size: 1rem;
  line-height: 1.7;
}

.section-heading {
  max-width: 720px;
  margin-bottom: 34px;
}

.program-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 20px;
}

.program-card {
  min-height: 310px;
  padding: 26px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #fff;
  box-shadow: 0 12px 34px rgba(15, 35, 70, 0.07);
  display: flex;
  flex-direction: column;
  align-items: flex-start;
}

.program-card.is-active {
  border-color: rgba(18, 99, 255, 0.36);
  box-shadow: var(--shadow);
}

.card-tag {
  display: inline-flex;
  min-height: 30px;
  align-items: center;
  padding: 0 12px;
  border-radius: 999px;
  color: var(--blue);
  background: #eaf1ff;
  font-size: 0.78rem;
  font-weight: 800;
}

.program-card h3 {
  margin: 20px 0 0;
  font-size: 1.38rem;
  line-height: 1.2;
}

.program-card p {
  margin: 14px 0 24px;
}

.program-card button {
  margin-top: auto;
  padding: 0 16px;
  color: #fff;
  background: var(--blue);
}

.curriculum {
  background: #fbfcff;
}

.timeline {
  display: grid;
  gap: 16px;
}

.timeline-item {
  display: grid;
  grid-template-columns: 76px 1fr;
  gap: 18px;
  padding: 22px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #fff;
}

.timeline-item span {
  width: 54px;
  height: 54px;
  border-radius: 8px;
  display: grid;
  place-items: center;
  color: #fff;
  background: var(--ink);
  font-weight: 800;
}

.timeline-item h3 {
  margin: 0;
  font-size: 1.2rem;
}

.timeline-item p {
  margin: 8px 0 0;
}

.mentors {
  color: #fff;
  background: var(--night);
}

.mentors .section-kicker {
  color: var(--mint);
}

.mentors p {
  color: #c7d4e8;
}

.mentor-list {
  display: grid;
  gap: 14px;
}

.mentor-list article {
  padding: 20px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.08);
}

.mentor-list strong,
.mentor-list span {
  display: block;
}

.mentor-list span {
  margin-top: 8px;
  color: #c7d4e8;
}

.stats-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 16px;
}

.stats-grid article {
  min-height: 150px;
  padding: 24px;
  border-radius: 8px;
  background: var(--soft);
}

.stats-grid strong {
  display: block;
  color: var(--blue);
  font-size: 2.4rem;
  line-height: 1;
}

.stats-grid span {
  display: block;
  margin-top: 12px;
  color: var(--muted);
  line-height: 1.45;
}

.final-cta {
  text-align: center;
  background: #edf7f5;
}

.final-cta .container {
  max-width: 760px;
}

.final-cta .primary-btn {
  min-height: 52px;
  margin-top: 26px;
  padding: 0 24px;
}

.site-footer {
  color: #c8d4e5;
  background: #08111f;
}

.footer-grid {
  display: grid;
  grid-template-columns: 1.4fr repeat(3, 1fr);
  gap: 36px;
  padding: 58px 0 34px;
}

.footer-brand {
  color: #fff;
}

.site-footer p {
  max-width: 330px;
  color: #9fb0c8;
  line-height: 1.6;
}

.site-footer h3 {
  margin: 0 0 14px;
  color: #fff;
  font-size: 1rem;
}

.site-footer a:not(.brand) {
  display: block;
  margin: 10px 0;
  color: #c8d4e5;
}

.site-footer a:hover {
  color: #fff;
}

.footer-bottom {
  display: flex;
  justify-content: space-between;
  gap: 20px;
  padding: 20px 0 30px;
  border-top: 1px solid rgba(255, 255, 255, 0.12);
  color: #9fb0c8;
}

@media (max-width: 980px) {
  .nav-toggle {
    display: block;
  }

  .nav-links,
  .nav-cta {
    display: none;
  }

  .nav.is-open {
    flex-wrap: wrap;
    padding: 14px 0;
  }

  .nav.is-open .nav-links,
  .nav.is-open .nav-cta {
    display: flex;
  }

  .nav.is-open .nav-links {
    width: 100%;
    flex-direction: column;
    align-items: flex-start;
    gap: 16px;
    padding: 16px 0 4px;
  }

  .hero {
    min-height: auto;
  }

  .hero-inner {
    margin: 0 auto;
    padding: 96px 0 330px;
  }

  .hero-dashboard {
    left: 50%;
    right: auto;
    bottom: 48px;
    width: min(520px, calc(100% - 40px));
    transform: translateX(-50%);
  }

  .split,
  .program-grid,
  .stats-grid,
  .footer-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 640px) {
  .container {
    width: min(100% - 28px, 1120px);
  }

  .nav {
    width: min(100% - 24px, 1180px);
  }

  .hero-inner {
    padding: 72px 0 340px;
  }

  .hero h1 {
    font-size: 2.55rem;
  }

  .hero-proof {
    grid-template-columns: 1fr;
  }

  .section {
    padding: 66px 0;
  }

  .timeline-item {
    grid-template-columns: 1fr;
  }

  .footer-bottom {
    flex-direction: column;
  }
}
`;
}

function buildScalerJs() {
  return `const nav = document.querySelector(".nav");
const navToggle = document.querySelector(".nav-toggle");
const callbackButtons = document.querySelectorAll("[data-callback]");
const programCards = document.querySelectorAll(".program-card");
const year = document.querySelector("#year");

if (year) {
  year.textContent = new Date().getFullYear();
}

if (nav && navToggle) {
  navToggle.addEventListener("click", () => {
    const isOpen = nav.classList.toggle("is-open");
    navToggle.setAttribute("aria-expanded", String(isOpen));
  });
}

programCards.forEach((card) => {
  card.addEventListener("click", () => {
    programCards.forEach((item) => item.classList.remove("is-active"));
    card.classList.add("is-active");
  });
});

callbackButtons.forEach((button) => {
  button.addEventListener("click", () => {
    alert("Thanks for your interest. An academic advisor would contact you shortly in a real Scaler flow.");
  });
});
`;
}

const toolMap = {
  getTheWeatherOfCity,
  getGithubDetailsAboutUser,
  executeCommand,
  writeFile,
  createScalerCloneWebsite,
};

function printStep(stepObject) {
  const step = stepObject.step || "UNKNOWN";
  const content = stepObject.content || "";
  const toolArgs =
    typeof stepObject.tool_args === "string"
      ? stepObject.tool_args
      : JSON.stringify(stepObject.tool_args || "");

  if (step === "START") {
    console.log(colorize("\nSTART", "blue"));
    console.log(content);
    return;
  }

  if (step === "THINK") {
    console.log(colorize("\nTHINK", "yellow"));
    console.log(content);
    return;
  }

  if (step === "TOOL") {
    console.log(colorize("\nTOOL", "magenta"));
    console.log(`${stepObject.tool_name}(${toolArgs})`);
    return;
  }

  if (step === "OBSERVE") {
    console.log(colorize("\nOBSERVE", "gray"));
    console.log(content);
    return;
  }

  if (step === "OUTPUT") {
    console.log(colorize("\nOUTPUT", "green"));
    console.log(content);
    return;
  }

  console.log(colorize(`\n${step}`, "cyan"));
  console.log(content);
}

async function callTool(toolName, toolArgs) {
  const tool = toolMap[toolName];
  if (!tool) {
    return `Tool "${toolName}" is not available. Available tools: ${Object.keys(toolMap).join(", ")}`;
  }

  try {
    return await tool(toolArgs);
  } catch (error) {
    return `Tool "${toolName}" failed: ${error.message}`;
  }
}

async function runAgentTurn(userInput, messages) {
  if (DEMO_MODE) {
    await runLocalDemoTurn(userInput);
    return;
  }

  messages.push({ role: "user", content: userInput });
  const scalerCloneRequested = isScalerCloneRequest(userInput);
  let ranExecuteCommand = false;
  let createdScalerWebsite = false;

  for (let stepNumber = 1; stepNumber <= MAX_AGENT_STEPS; stepNumber += 1) {
    let response;

    try {
      response = await client.chat.completions.create({
        model: MODEL,
        messages,
        response_format: { type: "json_object" },
      });
    } catch (error) {
      if (isQuotaError(error)) {
        console.log(colorize("\nOpenAI quota or billing error.", "red"));
        console.log("Your API key is valid, but the OpenAI account/project has no usable credits right now.");
        console.log("Fix it by adding billing/credits on the OpenAI dashboard, or set DEMO_MODE=true in .env for a local assignment demo.");
        return;
      }

      throw error;
    }

    const rawContent = response.choices?.[0]?.message?.content || "";
    let parsedContent;

    try {
      parsedContent = safeJsonParse(rawContent);
    } catch (error) {
      const observation = {
        step: "OBSERVE",
        content: `${error.message} Please return one valid JSON object only.`,
      };
      printStep(observation);
      messages.push({ role: "user", content: JSON.stringify(observation) });
      continue;
    }

    messages.push({ role: "assistant", content: JSON.stringify(parsedContent) });
    printStep(parsedContent);

    if (parsedContent.step === "TOOL") {
      const observationText = await callTool(parsedContent.tool_name, parsedContent.tool_args);
      ranExecuteCommand = ranExecuteCommand || parsedContent.tool_name === "executeCommand";
      createdScalerWebsite =
        createdScalerWebsite ||
        (parsedContent.tool_name === "createScalerCloneWebsite" &&
          observationText.includes("index.html") &&
          observationText.includes("style.css") &&
          observationText.includes("script.js"));

      const observation = { step: "OBSERVE", content: observationText };
      printStep(observation);
      messages.push({ role: "user", content: JSON.stringify(observation) });
      continue;
    }

    if (parsedContent.step === "OUTPUT") {
      if (scalerCloneRequested && (!ranExecuteCommand || !createdScalerWebsite)) {
        const missing = [
          !ranExecuteCommand ? "executeCommand" : "",
          !createdScalerWebsite ? "createScalerCloneWebsite" : "",
        ]
          .filter(Boolean)
          .join(" and ");
        const observation = {
          step: "OBSERVE",
          content: `The Scaler clone request is not complete yet. Call ${missing} before OUTPUT.`,
        };
        printStep(observation);
        messages.push({ role: "user", content: JSON.stringify(observation) });
        continue;
      }

      return;
    }
  }

  console.log(
    colorize(
      `\nAgent stopped after ${MAX_AGENT_STEPS} steps. Try a smaller request or increase MAX_AGENT_STEPS.`,
      "red",
    ),
  );
}

async function runLocalDemoTurn(userInput) {
  if (!isScalerCloneRequest(userInput)) {
    printStep({
      step: "OUTPUT",
      content:
        "DEMO_MODE is enabled. This local demo currently supports the assignment prompt: Clone the Scaler Academy website.",
    });
    return;
  }

  const steps = [
    {
      step: "START",
      content: "User wants a Scaler Academy inspired website clone generated as real files.",
    },
    {
      step: "THINK",
      content: "I will create a project folder first, then generate HTML, CSS, and JavaScript files.",
    },
    {
      step: "TOOL",
      tool_name: "executeCommand",
      tool_args: "mkdir -p scaler-academy-clone",
    },
    {
      step: "THINK",
      content: "The folder is ready. Now I will write the complete website files.",
    },
    {
      step: "TOOL",
      tool_name: "createScalerCloneWebsite",
      tool_args: JSON.stringify({ folderName: "scaler-academy-clone" }),
    },
    {
      step: "OUTPUT",
      content:
        "Done. Open scaler-academy-clone/index.html in your browser to view the generated Scaler Academy inspired clone.",
    },
  ];

  for (const step of steps) {
    printStep(step);

    if (step.step === "TOOL") {
      const observationText = await callTool(step.tool_name, step.tool_args);
      printStep({ step: "OBSERVE", content: observationText });
    }
  }
}

function printBanner() {
  console.log(colorize("Scaler Agent CLI", "cyan"));
  console.log("Chat with the agent in natural language. Type exit or quit to stop.");
  console.log('Try: "Clone the Scaler Academy website"');
  if (DEMO_MODE) {
    console.log(colorize("DEMO_MODE is enabled. Local assignment demo will run without OpenAI credits.", "yellow"));
  }
}

async function main() {
  if (!DEMO_MODE && !hasValidApiKey()) {
    console.log(colorize("Missing OPENAI_API_KEY.", "red"));
    console.log("Add your key to .env, for example: OPENAI_API_KEY=sk-...");
    console.log("For a local assignment demo without OpenAI credits, add DEMO_MODE=true to .env.");
    process.exitCode = 1;
    return;
  }

  const messages = [{ role: "system", content: systemPrompt }];
  const cli = readline.createInterface({ input, output });
  const firstPrompt = process.argv.slice(2).join(" ").trim();

  printBanner();

  try {
    if (firstPrompt) {
      await runAgentTurn(firstPrompt, messages);
      if (!input.isTTY) {
        return;
      }
    }

    while (true) {
      const answer = (await cli.question(colorize("\nYou > ", "cyan"))).trim();

      if (!answer) {
        continue;
      }

      if (["exit", "quit"].includes(answer.toLowerCase())) {
        console.log("Goodbye.");
        break;
      }

      await runAgentTurn(answer, messages);
    }
  } finally {
    cli.close();
  }
}

export { createScalerCloneWebsite, executeCommand, writeFile };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(colorize(`Fatal error: ${error.message}`, "red"));
    process.exitCode = 1;
  });
}
