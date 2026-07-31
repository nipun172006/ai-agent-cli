# AI Agent CLI

A conversational Node.js CLI agent that runs in the terminal, accepts natural language instructions, reasons through a visible agent loop, calls tools, and creates real files.

The main demo use case is:

```text
Clone the Scaler Academy website
```

The agent will create:

```text
scaler-academy-clone/
  index.html
  style.css
  script.js
```

The generated page includes a header, hero section, CTA buttons, program cards, curriculum sections, mentor/outcome sections, and footer.

## Features

- Conversational terminal loop using `readline`
- START, THINK, TOOL, OBSERVE, OUTPUT agent steps
- OpenAI-powered tool-calling loop
- `executeCommand` tool with project-local execution and a defensive command blocklist
- `writeFile` tool for creating files
- Model-generated HTML, CSS, and JavaScript written through `writeFile`
- Clean error handling for invalid JSON and failed tools

## Setup

Install dependencies:

```bash
npm install
```

Create a `.env` file:

```bash
cp .env.example .env
```

Add your API key and model settings:

```env
OPENAI_API_KEY=your-megallm-or-openai-key-here
OPENAI_BASE_URL=https://ai.megallm.io/v1
OPENAI_MODEL=openai-gpt-oss-20b
```

If you are using a direct OpenAI key instead of MegaLLM, remove `OPENAI_BASE_URL` and set `OPENAI_MODEL` to an OpenAI model available on your account.

## Run

Start the CLI:

```bash
npm start
```

Then type:

```text
Clone the Scaler Academy website
```

You can also pass the first prompt directly:

```bash
npm start -- "Clone the Scaler Academy website"
```

Open the generated page in your browser:

```text
scaler-academy-clone/index.html
```

Expected terminal flow:

```text
START
THINK
TOOL executeCommand("mkdir -p scaler-academy-clone")
OBSERVE
THINK
TOOL writeFile({"path":"scaler-academy-clone/index.html","content":"..."})
OBSERVE
THINK
TOOL writeFile({"path":"scaler-academy-clone/style.css","content":"..."})
OBSERVE
THINK
TOOL writeFile({"path":"scaler-academy-clone/script.js","content":"..."})
OBSERVE
OUTPUT
```

## Demo Checklist

For the 2 to 3 minute YouTube video:

1. Show `npm start` running in the terminal.
2. Enter `Clone the Scaler Academy website`.
3. Show the START, THINK, TOOL, OBSERVE, OUTPUT loop.
4. Show the generated files in `scaler-academy-clone`.
5. Open `index.html` in a browser and scroll through the page.

## Project Structure

```text
.
|-- index.js
|-- package.json
|-- package-lock.json
|-- .env.example
`-- README.md
```

## Notes

This project generates an educational Scaler Academy inspired clone for an assignment demo. It is not affiliated with Scaler and does not copy Scaler source code.

## Safety boundary

- File writes resolve relative paths and reject paths outside the current
  project directory.
- Shell commands run with the project as their working directory, a 30-second
  timeout, and a blocklist for common destructive/system-level commands.
- A blocklist is not a complete sandbox. Model-generated commands can still be
  unsafe or access network and user-visible project files.
- Run the agent in a disposable project directory, inspect tool calls before
  relying on their output, and do not use it with sensitive files or broad
  system permissions.

## Validation

```bash
npm test
npm run check
```

The coursework origin and Scaler-inspired demonstration remain disclosed; the
repository is not affiliated with Scaler.
