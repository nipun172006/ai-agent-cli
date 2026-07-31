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
let client;

function getClient() {
  if (!client) {
    client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY || process.env.MEGALLM_API_KEY || process.env.API_KEY,
      baseURL: process.env.OPENAI_BASE_URL,
    });
  }

  return client;
}

const ROOT_DIR = process.cwd();
const MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const MAX_AGENT_STEPS = Number(process.env.MAX_AGENT_STEPS || 40);
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
7. When writing files, put the complete file content in writeFile tool_args as JSON:
   {"path":"relative/path","content":"complete file content"}
8. For a Scaler Academy website clone request:
   - START the task.
   - THINK about the required sections and visual style.
   - call executeCommand with "mkdir -p scaler-academy-clone".
   - after OBSERVE, write scaler-academy-clone/index.html using writeFile.
   - after OBSERVE, write scaler-academy-clone/style.css using writeFile.
   - after OBSERVE, write scaler-academy-clone/script.js using writeFile.
   - generate polished, complete file contents, not placeholder snippets.
   - include at minimum a header, hero section, and footer.
   - also include believable Scaler-style sections: program/course cards, learner outcomes, curriculum highlights, mentorship, company/hiring proof, and a final CTA.
   - visually resemble Scaler Academy through a clean blue-and-white education-tech style, sticky header, strong hero, rounded cards, CTA buttons, stats, responsive grids, and professional spacing.
   - use original educational copy inspired by Scaler Academy. Do not copy proprietary source code.
   - make index.html link to ./style.css and ./script.js.
   - make style.css responsive for desktop and mobile, with strong first-screen visual impact.
   - make script.js add meaningful interaction such as mobile nav toggle, active course cards, smooth scrolling, and callback form/alert behavior.
   - do not claim the files are complete until all three files have been written.
   - after the final OBSERVE, OUTPUT the created file paths and how to open index.html.

Available tools:
1. getTheWeatherOfCity(cityname: string): fetches live weather for a city.
2. getGithubDetailsAboutUser(username: string): fetches public GitHub profile details.
3. executeCommand(cmd: string): executes a safe shell command in the current project directory. It can create folders.
4. writeFile({"path":"relative/path","content":"text"}): writes a UTF-8 file inside the project.
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
    {
      pattern: /\brm\s+(?:-[a-z]*r[a-z]*|--recursive)(?:\s|$)/i,
      reason: "recursive deletion is blocked",
    },
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

const toolMap = {
  getTheWeatherOfCity,
  getGithubDetailsAboutUser,
  executeCommand,
  writeFile,
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

function getWrittenFilePath(toolName, toolArgs, observationText) {
  if (toolName !== "writeFile" || !observationText.startsWith("Wrote ")) {
    return "";
  }

  const args = parseToolArgs(toolArgs);
  return typeof args?.path === "string" ? args.path : "";
}

function missingScalerFiles(writtenFiles) {
  return ["scaler-academy-clone/index.html", "scaler-academy-clone/style.css", "scaler-academy-clone/script.js"].filter(
    (filePath) => !writtenFiles.has(filePath),
  );
}

async function runAgentTurn(userInput, messages) {
  if (DEMO_MODE) {
    printStep({
      step: "OUTPUT",
      content:
        "DEMO_MODE is enabled, so the OpenAI model is not being called. Disable DEMO_MODE for the assignment flow where the model generates and writes the website files.",
    });
    return;
  }

  messages.push({ role: "user", content: userInput });
  const scalerCloneRequested = isScalerCloneRequest(userInput);
  let createdScalerFolder = false;
  const writtenFiles = new Set();

  for (let stepNumber = 1; stepNumber <= MAX_AGENT_STEPS; stepNumber += 1) {
    let response;

    try {
      response = await getClient().chat.completions.create({
        model: MODEL,
        messages,
        response_format: { type: "json_object" },
      });
    } catch (error) {
      if (isQuotaError(error)) {
        console.log(colorize("\nOpenAI quota or billing error.", "red"));
        console.log("Your API key is valid, but the OpenAI account/project has no usable credits right now.");
        console.log("Add billing/credits on the OpenAI dashboard, then run this again for the assignment demo.");
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

      createdScalerFolder =
        createdScalerFolder ||
        (parsedContent.tool_name === "executeCommand" &&
          getStringArg(parsedContent.tool_args, ["cmd", "command"]).trim() === "mkdir -p scaler-academy-clone" &&
          !observationText.includes("failed"));

      const writtenFilePath = getWrittenFilePath(
        parsedContent.tool_name,
        parsedContent.tool_args,
        observationText,
      );
      if (writtenFilePath) {
        writtenFiles.add(writtenFilePath);
      }

      const observation = { step: "OBSERVE", content: observationText };
      printStep(observation);
      messages.push({ role: "user", content: JSON.stringify(observation) });
      continue;
    }

    if (parsedContent.step === "OUTPUT") {
      if (scalerCloneRequested) {
        const missingFiles = missingScalerFiles(writtenFiles);
        if (!createdScalerFolder || missingFiles.length > 0) {
          const missingWork = [
            !createdScalerFolder ? 'call executeCommand with "mkdir -p scaler-academy-clone"' : "",
            missingFiles.length > 0 ? `write these files with writeFile: ${missingFiles.join(", ")}` : "",
          ]
            .filter(Boolean)
            .join("; ");

          const observation = {
            step: "OBSERVE",
            content: `The Scaler clone request is not complete yet. Please ${missingWork} before OUTPUT.`,
          };
          printStep(observation);
          messages.push({ role: "user", content: JSON.stringify(observation) });
          continue;
        }
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

function printBanner() {
  console.log(colorize("Scaler Agent CLI", "cyan"));
  console.log("Chat with the agent in natural language. Type exit or quit to stop.");
  console.log('Try: "Clone the Scaler Academy website"');
  if (DEMO_MODE) {
    console.log(colorize("DEMO_MODE is enabled. Disable it for model-generated website files.", "yellow"));
  }
}

async function main() {
  if (!DEMO_MODE && !hasValidApiKey()) {
    console.log(colorize("Missing OPENAI_API_KEY.", "red"));
    console.log("Add your key to .env, for example: OPENAI_API_KEY=sk-...");
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

export { assertSafeCommand, executeCommand, resolveInsideWorkspace, writeFile };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(colorize(`Fatal error: ${error.message}`, "red"));
    process.exitCode = 1;
  });
}
