# Assignment 02: AI Agent CLI Tool

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
- `executeCommand` tool for safe shell commands inside the project
- `writeFile` tool for creating files
- Deterministic Scaler Academy inspired website generator for reliable demos
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
DEMO_MODE=false
```

If you are using a direct OpenAI key instead of MegaLLM, remove `OPENAI_BASE_URL` and set `OPENAI_MODEL` to an OpenAI model available on your account.

If your API account has no credits and you get a quota/billing error, you can still run the local assignment demo by setting:

```env
DEMO_MODE=true
```

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
TOOL createScalerCloneWebsite({"folderName":"scaler-academy-clone"})
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
