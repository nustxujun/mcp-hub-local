import { spawn, execFileSync } from 'node:child_process';

/** Hub built-in tool names (no prefix needed since they are Hub-level) */
export const HUB_TOOL_SEARCH = 'search_tools';
export const HUB_TOOL_EXECUTE = 'execute_code';

/** MCP Tool definitions for the two Hub built-in tools */
export const HUB_TOOLS_DEFINITIONS = [
  {
    name: HUB_TOOL_SEARCH,
    description: [
      'Search available tools across all connected MCPs. Returns Python function signatures for use in execute_code.',
      '',
      '⚠️ MANDATORY WORKFLOW — You MUST follow these steps for ANY tool usage:',
      '  1. PLAN: Identify ALL information you need to collect or actions to perform for the task.',
      '  2. SEARCH: Call search_tools multiple times with different keywords to discover ALL relevant tools.',
      '     - Search by MCP name (e.g. filter="mcp-name")',
      '     - Search by capability keyword (e.g. filter="list", filter="create", filter="query")',
      '     - Keep searching until you have a complete picture of available tools for your task.',
      '  3. EXECUTE ONCE: Write ONE execute_code call that combines ALL tool calls into a single script.',
      '',
      '❌ NEVER call execute_code without first searching for tools.',
      '❌ NEVER skip this search step, even if you think you know the tool names.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        filter: {
          type: 'string',
          description: [
            'Keyword to filter tools by name, description, or MCP slug.',
            'Supports space-separated multiple keywords with smart ranking:',
            '  - Tools matching ALL keywords rank highest (AND mode, score ×2)',
            '  - Tools matching SOME keywords also returned but ranked lower (OR fallback)',
            '  - Scoring priority: tool name exact word > MCP slug exact word > name substring > slug substring > description word > description substring',
            'Tips: Use specific tool names or capability keywords (e.g. "read file", "list", "query database").',
            'Call multiple times with different keywords to build a complete picture before writing code.',
          ].join(' '),
        },
      },
      required: ['filter'],
    },
  },
  {
    name: HUB_TOOL_EXECUTE,
    description: [
      'Execute a Python script that calls MCP tools. All tool functions discovered via search_tools are pre-injected and callable directly.',
      '',
      '⚠️ CRITICAL RULES:',
      '  1. ONE SCRIPT PER TASK: Write ONE comprehensive script — do NOT call execute_code multiple times.',
      '     Combine all tool calls, data processing, and logic into a single script.',
      '     This keeps intermediate data inside the script and OUT of the conversation context.',
      '  2. BATCH EVERYTHING: When investigating or diagnosing, batch all queries into a single script.',
      '     Collect all metrics, statuses, logs, and data in one execution — not separate calls for each.',
      '  3. HANDLE ERRORS: Wrap individual tool calls in try/except so one failure does not crash the entire script.',
      '     Collect partial results and report which calls succeeded and which failed.',
      '  4. COMPACT RESULTS: Filter and aggregate data inside the script. Return only key fields the user needs.',
      '     Do NOT dump entire raw responses — extract, summarize, and format before assigning to result.',
      '  5. PREFER OVER-FETCHING: When unsure what data you will need next, fetch MORE in one call rather than',
      '     making a second call later. Include related/adjacent queries even if you might not need them all.',
      '     The cost of unused data inside a script is near zero; the cost of an extra execute_code call is high.',
      '  6. MERGE ON FOLLOW-UP: When the user asks a follow-up question about the same topic, do NOT write',
      '     a minimal incremental script. Rewrite a COMPLETE script that includes both the previous logic',
      '     and the new requirement, so all context stays inside one execution.',
      '',
      'Script patterns:',
      '  - Sequential:    a = tool_a(arg="x"); b = tool_b(input=a); result = b',
      '  - Batch:         results = [tool_a(q=q) for q in queries]; result = results',
      '  - Conditional:   data = tool_a(); result = tool_b(id=data["id"]) if data else None',
      '  - Resilient:     results = {}; [try/except per call to collect partial results on failure]',
      '  - Multi-step:    Write full logic with variables, loops, and conditionals — no limit on complexity.',
      '',
      'Assign `result = <value>` to return the final output. Use `print()` for debug logging.',
      '',
      'ON ERROR: If a script fails, analyze the error, fix the root cause, and rewrite the COMPLETE script.',
      'Do NOT patch with a second execute_code call — always submit a single self-contained script.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'Complete Python script combining ALL needed tool calls for the task. All tool functions accept keyword arguments. Process and filter data within the script. Assign only the final user-facing output to `result`.',
        },
      },
      required: ['code'],
    },
  },
];

export interface ToolSignatureEntry {
  /** Prefixed tool name (mcpSlug__toolName) */
  prefixedName: string;
  /** MCP slug */
  mcpSlug: string;
  /** Original tool name */
  originalName: string;
  /** Generated Python function signature with docstring */
  signature: string;
  /** Tool description */
  description: string;
  /** The safe function name used in code execution context */
  functionName: string;
}

export interface SearchResult {
  /** Matched tool entries, sorted by relevance (best first) */
  entries: ToolSignatureEntry[];
  /** Number of results where ALL keywords matched */
  exactCount: number;
  /** Number of results where only SOME keywords matched */
  partialCount: number;
}

/** Pre-processed search index entry for a single tool (built once, queried many times) */
export interface ToolIndexEntry {
  /** Reference to the original signature */
  sig: ToolSignatureEntry;
  /** originalName split by '_', lowercased */
  nameParts: string[];
  /** mcpSlug split by '-', lowercased */
  slugParts: string[];
  /** originalName lowercased (for substring search) */
  nameLower: string;
  /** mcpSlug lowercased (for substring search) */
  slugLower: string;
  /** description lowercased, punctuation stripped, split by whitespace (Set for O(1) exact word lookup) */
  descWordSet: Set<string>;
  /** description lowercased (for substring search) */
  descLower: string;
}

// ── Python interpreter detection ──

let cachedPythonCmd: string | null = null;

function detectPython(): string {
  if (cachedPythonCmd) return cachedPythonCmd;

  const candidates = process.platform === 'win32'
    ? ['python', 'python3', 'py']
    : ['python3', 'python'];

  for (const cmd of candidates) {
    try {
      execFileSync(cmd, ['--version'], { stdio: 'pipe', timeout: 5000, windowsHide: true });
      cachedPythonCmd = cmd;
      return cmd;
    } catch {
      // try next
    }
  }
  throw new Error('Python not found. Please install Python 3 and ensure it is on PATH.');
}

export class PTCService {

  /** Convert JSON Schema type to Python type string */
  private schemaToPython(schema: any): string {
    if (!schema) return 'Any';

    if (schema.enum) {
      return 'Literal[' + schema.enum.map((v: any) => typeof v === 'string' ? `"${v}"` : String(v)).join(', ') + ']';
    }

    switch (schema.type) {
      case 'string': return 'str';
      case 'number': return 'float';
      case 'integer': return 'int';
      case 'boolean': return 'bool';
      case 'null': return 'None';
      case 'array': {
        const itemType = schema.items ? this.schemaToPython(schema.items) : 'Any';
        return `list[${itemType}]`;
      }
      case 'object': {
        if (!schema.properties) return 'dict';
        return 'dict';
      }
      default:
        if (schema.anyOf || schema.oneOf) {
          const variants = (schema.anyOf || schema.oneOf) as any[];
          return variants.map((v: any) => this.schemaToPython(v)).join(' | ');
        }
        return 'Any';
    }
  }

  /** Convert prefixed name to a valid Python identifier */
  private toFunctionName(prefixedName: string): string {
    return prefixedName.replace(/[^a-zA-Z0-9_]/g, '_');
  }

  /** Generate a Python function signature with docstring for a single tool */
  generateSignature(tool: { name: string; description?: string; inputSchema?: any }, mcpSlug: string): ToolSignatureEntry {
    const originalName = tool.name;
    const prefixedName = `${mcpSlug}__${originalName}`;
    const functionName = this.toFunctionName(prefixedName);

    const descLine = tool.description || originalName;

    // Build kwargs parameter list
    const paramLines: string[] = [];
    const docArgLines: string[] = [];

    if (tool.inputSchema?.properties) {
      const required = new Set(tool.inputSchema.required || []);
      for (const [key, prop] of Object.entries(tool.inputSchema.properties) as [string, any][]) {
        const pyType = this.schemaToPython(prop);
        const paramDesc = prop.description || '';

        if (required.has(key)) {
          paramLines.push(`    ${key}: ${pyType},`);
        } else {
          paramLines.push(`    ${key}: ${pyType} | None = None,`);
        }
        docArgLines.push(`        ${key}: ${paramDesc}`);
      }
    }

    // Build signature
    const sigLines: string[] = [];
    if (paramLines.length > 0) {
      sigLines.push(`def ${functionName}(`);
      sigLines.push('    *,');
      sigLines.push(...paramLines);
      sigLines.push(') -> Any:');
    } else {
      sigLines.push(`def ${functionName}() -> Any:`);
    }

    // Build docstring
    sigLines.push(`    """[${mcpSlug}] ${descLine}`);
    if (docArgLines.length > 0) {
      sigLines.push('');
      sigLines.push('    Args:');
      sigLines.push(...docArgLines);
    }
    sigLines.push('    """');
    sigLines.push('    ...');

    const signature = sigLines.join('\n');

    return {
      prefixedName,
      mcpSlug,
      originalName,
      signature,
      description: descLine,
      functionName,
    };
  }

  /** Batch generate signatures for all tools */
  generateAllSignatures(tools: Array<{ name: string; description?: string; inputSchema?: any }>, mcpSlug: string): ToolSignatureEntry[] {
    return tools.map(tool => this.generateSignature(tool, mcpSlug));
  }

  /** Build a pre-processed search index from signatures (call once when cache is populated) */
  buildSearchIndex(signatures: ToolSignatureEntry[]): ToolIndexEntry[] {
    return signatures.map(sig => ({
      sig,
      nameParts: sig.originalName.toLowerCase().split('_'),
      slugParts: sig.mcpSlug.toLowerCase().split('-'),
      nameLower: sig.originalName.toLowerCase(),
      slugLower: sig.mcpSlug.toLowerCase(),
      descWordSet: new Set(sig.description.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(Boolean)),
      descLower: sig.description.toLowerCase(),
    }));
  }

  /**
   * Search tools by filter keywords with intelligent scoring using a pre-built index.
   *
   * Scoring rules (per keyword per tool):
   *   - Exact word match in originalName (split by _):  20
   *   - Exact word match in mcpSlug (split by -):       15
   *   - Substring match in originalName:                10
   *   - Substring match in mcpSlug:                      8
   *   - Exact word match in description:                 5
   *   - Substring match in description:                  3
   *
   * AND/OR hybrid:
   *   - If ALL keywords match → total score ×2 (AND bonus)
   *   - Partial matches also returned but ranked lower
   *   - Partial matches capped at 5 to avoid flooding context
   *   - Results sorted by descending score
   */
  searchTools(index: ToolIndexEntry[], filter: string): SearchResult {
    if (!filter || !filter.trim()) {
      return { entries: index.map(e => e.sig), exactCount: 0, partialCount: 0 };
    }

    const keywords = filter.toLowerCase().split(/\s+/).filter(Boolean);

    const scored: Array<{ sig: ToolSignatureEntry; score: number; allMatch: boolean }> = [];

    for (const entry of index) {
      let totalScore = 0;
      let matchedCount = 0;

      for (const kw of keywords) {
        let kwScore = 0;

        // 1. Exact word match in originalName parts (highest priority)
        if (entry.nameParts.includes(kw)) {
          kwScore = 20;
        }
        // 2. Exact word match in mcpSlug parts
        if (kwScore < 15 && entry.slugParts.includes(kw)) {
          kwScore = 15;
        }
        // 3. Substring match in originalName
        if (kwScore < 10 && entry.nameLower.includes(kw)) {
          kwScore = 10;
        }
        // 4. Substring match in mcpSlug
        if (kwScore < 8 && entry.slugLower.includes(kw)) {
          kwScore = 8;
        }
        // 5. Exact word match in description
        if (kwScore < 5 && entry.descWordSet.has(kw)) {
          kwScore = 5;
        }
        // 6. Substring match in description
        if (kwScore < 3 && entry.descLower.includes(kw)) {
          kwScore = 3;
        }

        if (kwScore > 0) {
          matchedCount++;
        }
        totalScore += kwScore;
      }

      if (totalScore === 0) continue;

      const allMatch = matchedCount === keywords.length;
      // AND bonus: if all keywords matched, double the score
      if (allMatch) {
        totalScore *= 2;
      }

      scored.push({ sig: entry.sig, score: totalScore, allMatch });
    }

    // Sort: AND matches first, then by score descending
    scored.sort((a, b) => {
      if (a.allMatch !== b.allMatch) return a.allMatch ? -1 : 1;
      return b.score - a.score;
    });

    const exactCount = scored.filter(s => s.allMatch).length;
    const partialCount = scored.filter(s => !s.allMatch).length;

    // Cap partial matches to avoid flooding AI context
    const MAX_PARTIAL = 5;
    let entries: ToolSignatureEntry[];
    if (partialCount > MAX_PARTIAL) {
      const exactEntries = scored.filter(s => s.allMatch).map(s => s.sig);
      const partialEntries = scored.filter(s => !s.allMatch).slice(0, MAX_PARTIAL).map(s => s.sig);
      entries = [...exactEntries, ...partialEntries];
    } else {
      entries = scored.map(s => s.sig);
    }

    return { entries, exactCount, partialCount: Math.min(partialCount, MAX_PARTIAL) };
  }

  /** Execute Python code in a child process with injected tool call functions via stdin/stdout JSON line protocol */
  async executeCode(
    code: string,
    signatures: ToolSignatureEntry[],
    callTool: (mcpSlug: string, toolName: string, args: any) => Promise<any>,
  ): Promise<{ result: any; logs: string[] }> {
    const pythonCmd = detectPython();

    // Build tool wrapper functions
    const wrapperLines: string[] = [];
    for (const entry of signatures) {
      wrapperLines.push(`def ${entry.functionName}(**kwargs):`);
      wrapperLines.push(`    return _call_tool("${entry.functionName}", kwargs)`);
      wrapperLines.push('');
    }

    // Build the full Python script
    const script = `
import sys, json, io, traceback

# ── Bridge layer: communicate with Node.js via real stdout/stdin ──
_real_stdout = sys.stdout
_real_stdin = sys.stdin

def _call_tool(name, args):
    req = json.dumps({"type": "call", "name": name, "args": args})
    _real_stdout.write(req + "\\n")
    _real_stdout.flush()
    resp_line = _real_stdin.readline()
    if not resp_line:
        raise Exception("Bridge connection closed unexpectedly")
    resp = json.loads(resp_line)
    if resp.get("type") == "error":
        raise Exception(resp.get("message", "Tool call failed"))
    return resp.get("data")

# ── Tool wrapper functions ──
${wrapperLines.join('\n')}

# ── Redirect print() to capture logs ──
_capture_buf = io.StringIO()
sys.stdout = _capture_buf

# ── User code ──
result = None
try:
${code.split('\n').map(line => '    ' + line).join('\n')}
except Exception as _e:
    _tb = traceback.format_exc()
    sys.stdout = _real_stdout
    _logs = _capture_buf.getvalue().strip().split("\\n") if _capture_buf.getvalue().strip() else []
    _logs.append("[EXECUTION ERROR] " + _tb)
    _real_stdout.write(json.dumps({"type": "done", "result": None, "logs": _logs}) + "\\n")
    _real_stdout.flush()
    sys.exit(0)

# ── Collect results ──
sys.stdout = _real_stdout
_captured = _capture_buf.getvalue()
_logs = _captured.strip().split("\\n") if _captured.strip() else []
_real_stdout.write(json.dumps({"type": "done", "result": result, "logs": _logs}) + "\\n")
_real_stdout.flush()
`;

    // Mapping from functionName to { mcpSlug, originalName }
    const fnMap = new Map<string, { mcpSlug: string; originalName: string }>();
    for (const entry of signatures) {
      fnMap.set(entry.functionName, { mcpSlug: entry.mcpSlug, originalName: entry.originalName });
    }

    return new Promise<{ result: any; logs: string[] }>((resolve) => {
      const proc = spawn(pythonCmd, ['-u', '-c', script], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
        windowsHide: true,
      });

      let stderrBuf = '';
      let resolved = false;

      const finish = (result: any, logs: string[]) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        resolve({ result, logs });
      };

      // Timeout: 5 minutes
      const timer = setTimeout(() => {
        if (!resolved) {
          try { proc.kill('SIGKILL'); } catch { /* ignore */ }
          finish(null, ['[TIMEOUT] Python execution exceeded 5 minutes']);
        }
      }, 300000);

      proc.stderr!.on('data', (chunk: Buffer) => {
        stderrBuf += chunk.toString();
      });

      // Process stdout line by line
      let stdoutBuf = '';
      proc.stdout!.on('data', (chunk: Buffer) => {
        stdoutBuf += chunk.toString();
        const lines = stdoutBuf.split('\n');
        stdoutBuf = lines.pop() || ''; // keep incomplete line in buffer

        for (const line of lines) {
          if (!line.trim()) continue;
          let msg: any;
          try {
            msg = JSON.parse(line);
          } catch {
            // Non-JSON output — should not happen since we redirect print
            continue;
          }

          if (msg.type === 'call') {
            // Tool call request from Python
            const fnName = msg.name as string;
            const args = msg.args || {};
            const mapping = fnMap.get(fnName);

            if (!mapping) {
              // Unknown function — respond with error
              const errResp = JSON.stringify({ type: 'error', message: `Unknown tool function: ${fnName}` });
              proc.stdin!.write(errResp + '\n');
              return;
            }

            callTool(mapping.mcpSlug, mapping.originalName, args)
              .then((data) => {
                const resp = JSON.stringify({ type: 'result', data });
                proc.stdin!.write(resp + '\n');
              })
              .catch((err) => {
                const resp = JSON.stringify({ type: 'error', message: String(err) });
                proc.stdin!.write(resp + '\n');
              });

          } else if (msg.type === 'done') {
            finish(msg.result ?? null, msg.logs || []);
          }
        }
      });

      proc.on('close', (exitCode) => {
        // Process any remaining data in buffer
        if (stdoutBuf.trim()) {
          try {
            const msg = JSON.parse(stdoutBuf.trim());
            if (msg.type === 'done') {
              finish(msg.result ?? null, msg.logs || []);
              return;
            }
          } catch { /* ignore */ }
        }

        if (!resolved) {
          const logs: string[] = [];
          if (stderrBuf.trim()) {
            logs.push(`[STDERR] ${stderrBuf.trim()}`);
          }
          if (exitCode !== 0) {
            logs.push(`[EXIT] Python process exited with code ${exitCode}`);
          }
          finish(null, logs.length > 0 ? logs : ['[ERROR] Python process ended without returning results']);
        }
      });

      proc.on('error', (err) => {
        finish(null, [`[SPAWN ERROR] ${err.message}`]);
      });
    });
  }
}
