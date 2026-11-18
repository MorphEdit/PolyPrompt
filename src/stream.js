// Claude Code stream-json protocol (`--input-format stream-json`,
// `--output-format stream-json`, `--permission-prompt-tool stdio`). Every line the
// runner reads from or writes to `claude` is parsed or built here, so the
// format can be adjusted in one place if the real CLI differs.

export const DENY_MESSAGE = 'The user refused this action.';

const line = (value) => JSON.stringify(value) + '\n';

// The prompt, as the one user message written to stdin.
export function userLine(prompt) {
  return line({ type: 'user', message: { role: 'user', content: String(prompt ?? '') } });
}

// The answer to a `can_use_tool` request: behavior is 'allow' or 'deny'.
export function permissionResponseLine(requestId, behavior, input) {
  const response = behavior === 'allow'
    ? { behavior: 'allow', updatedInput: input ?? {} }
    : { behavior: 'deny', message: DENY_MESSAGE };
  return line({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
}

// The answer to a control request the app does not handle.
export function unsupportedResponseLine(requestId) {
  return line({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error: 'unsupported request' } });
}

export function parseLine(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

// Plain text of a tool_result's content (a string or an array of blocks).
export function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((b) => (b?.type === 'text' && typeof b.text === 'string' ? b.text : JSON.stringify(b))).join('\n');
  }
  return content == null ? '' : JSON.stringify(content);
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Classifies one parsed stdout event:
// { sessionId, kind: 'permission', requestId, toolName, input }
// | { sessionId, kind: 'control', requestId }               (other control requests)
// | { sessionId, kind: 'assistant', texts, toolUses: [{ id, name, input }] }
// | { sessionId, kind: 'tool_results', results: [{ id, output }] }
// | { sessionId, kind: 'result', isError, text }
// | { sessionId, kind: 'other' }
export function readEvent(ev) {
  const sessionId = typeof ev.session_id === 'string' && ev.session_id ? ev.session_id : null;
  if (ev.type === 'control_request') {
    const req = isObject(ev.request) ? ev.request : {};
    const requestId = typeof ev.request_id === 'string' ? ev.request_id : null;
    if (requestId && req.subtype === 'can_use_tool' && typeof req.tool_name === 'string') {
      return { sessionId, kind: 'permission', requestId, toolName: req.tool_name, input: isObject(req.input) ? req.input : {} };
    }
    return { sessionId, kind: 'control', requestId };
  }
  if (ev.type === 'result') {
    return {
      sessionId, kind: 'result', isError: ev.is_error === true, text: typeof ev.result === 'string' ? ev.result : null,
      modelUsage: isObject(ev.modelUsage) ? ev.modelUsage : null,
    };
  }
  const content = ev.message?.content;
  if (ev.type === 'assistant' && Array.isArray(content)) {
    const texts = [];
    const toolUses = [];
    for (const b of content) {
      if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) texts.push(b.text);
      else if (b?.type === 'tool_use' && typeof b.name === 'string') {
        toolUses.push({ id: b.id ?? null, name: b.name, input: isObject(b.input) ? b.input : {} });
      }
    }
    return { sessionId, kind: 'assistant', texts, toolUses };
  }
  if (ev.type === 'user' && Array.isArray(content)) {
    const results = content
      .filter((b) => b?.type === 'tool_result')
      .map((b) => ({ id: b.tool_use_id ?? null, output: resultText(b.content) }));
    return { sessionId, kind: 'tool_results', results };
  }
  return { sessionId, kind: 'other' };
}
