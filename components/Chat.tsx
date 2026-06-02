'use client';

import { useState, useRef, useEffect, useCallback } from 'react';

interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: number;
}

const STORAGE_KEY = 'vercel-chat-history-v1';
const MODEL_KEY = 'vercel-chat-model-v1';
const SYS_KEY = 'vercel-chat-system-v1';

const MODELS = [
  { value: 'cognitivecomputations/dolphin-mistral-24b-venice-edition:free', label: 'Dolphin Mistral 24B Venice (Free)' },
  { value: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  { value: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
  { value: 'z-ai/glm-4.5-air:free', label: 'Z-AI GLM-4.5 Air (Free)' },
  { value: 'openai/gpt-4o-mini', label: 'GPT-4o Mini' },
];

function formatText(text: string): string {
  let safe = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  safe = safe.replace(/```(\w+)?\n([\s\S]*?)```/g, '<pre style="background:rgba(110,118,129,0.15);padding:12px;border-radius:8px;overflow-x:auto;margin:8px 0;font-family:monospace;font-size:0.9em;"><code>$2</code></pre>');
  safe = safe.replace(/`([^`]+)`/g, '<code style="background:rgba(110,118,129,0.2);padding:2px 6px;border-radius:4px;font-family:monospace;font-size:0.9em;">$1</code>');
  safe = safe.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  safe = safe.replace(/\*(.+?)\*/g, '<em>$1</em>');
  safe = safe.replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer" style="color:#58a6ff;text-decoration:none;">$1</a>');
  safe = safe.replace(/\n/g, '<br>');
  return safe;
}

export default function Chat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [model, setModel] = useState(MODELS[0].value);
  const [systemPrompt, setSystemPrompt] = useState('');
  const [showSystem, setShowSystem] = useState(false);
  const [retryCountdown, setRetryCountdown] = useState<number | null>(null);
  const chatRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) setMessages(JSON.parse(raw));
      const m = localStorage.getItem(MODEL_KEY);
      if (m) setModel(m);
      const s = localStorage.getItem(SYS_KEY);
      if (s) setSystemPrompt(s);
    } catch {}
  }, []);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
  }, [messages]);

  useEffect(() => {
    localStorage.setItem(MODEL_KEY, model);
  }, [model]);

  useEffect(() => {
    localStorage.setItem(SYS_KEY, systemPrompt);
  }, [systemPrompt]);

  useEffect(() => {
    if (chatRef.current) {
      chatRef.current.scrollTop = chatRef.current.scrollHeight;
    }
  }, [messages, isGenerating]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  }, []);

  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

  const sendMessage = async () => {
    const text = input.trim();
    if (!text || isGenerating) return;

    const userMsg: Message = { role: 'user', content: text, createdAt: Date.now() };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setIsGenerating(true);
    if (textareaRef.current) textareaRef.current.style.height = 'auto';

    const historyMessages = [...messages, userMsg];
    const apiMessages: { role: string; content: string }[] = [];
    if (systemPrompt.trim()) {
      apiMessages.push({ role: 'system', content: systemPrompt.trim() });
    }
    apiMessages.push(...historyMessages.map(m => ({ role: m.role, content: m.content })));

    abortRef.current = new AbortController();
    let assistantText = '';
    const MAX_RETRIES = 3;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: apiMessages,
            model,
            temperature: 0.7,
            max_tokens: 4096,
          }),
          signal: abortRef.current.signal,
        });

        if (!res.ok) {
          const errBody = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
          let retrySec = 2;

          // Parse OpenRouter 429 error for retry-after
          if (res.status === 429) {
            try {
              const inner = JSON.parse(errBody.error);
              const raw = inner.error?.metadata?.retry_after_seconds;
              if (typeof raw === 'number') retrySec = Math.ceil(raw);
            } catch {}

            if (attempt < MAX_RETRIES) {
              setMessages(prev => [...prev, {
                role: 'system',
                content: `⏳ Rate limited by OpenRouter. Retrying in ${retrySec}s... (attempt ${attempt}/${MAX_RETRIES})`,
                createdAt: Date.now(),
              }]);
              setRetryCountdown(retrySec);
              for (let i = retrySec; i > 0; i--) {
                setRetryCountdown(i);
                await sleep(1000);
              }
              setRetryCountdown(null);
              continue; // retry
            }
          }

          const errorMsg: Message = {
            role: 'system',
            content: `Error: ${errBody.error || errBody.message || 'Unknown error'}`,
            createdAt: Date.now(),
          };
          setMessages(prev => [...prev, errorMsg]);
          break;
        }

        const reader = res.body?.getReader();
        if (!reader) {
          setMessages(prev => [...prev, { role: 'system', content: 'Error: No response body', createdAt: Date.now() }]);
          break;
        }

        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6);
            if (data === '[DONE]') continue;
            try {
              const parsed = JSON.parse(data);
              const delta = parsed.choices?.[0]?.delta?.content || '';
              if (delta) {
                assistantText += delta;
                setMessages(prev => {
                  const last = prev[prev.length - 1];
                  if (last && last.role === 'assistant') {
                    return [...prev.slice(0, -1), { ...last, content: assistantText }];
                  }
                  return [...prev, { role: 'assistant', content: assistantText, createdAt: Date.now() }];
                });
              }
            } catch {
              // ignore malformed SSE lines
            }
          }
        }

        // flush remaining
        if (buffer.startsWith('data: ')) {
          const data = buffer.slice(6);
          if (data && data !== '[DONE]') {
            try {
              const parsed = JSON.parse(data);
              const delta = parsed.choices?.[0]?.delta?.content || '';
              if (delta) assistantText += delta;
            } catch {}
          }
        }
        if (assistantText) {
          setMessages(prev => {
            const last = prev[prev.length - 1];
            if (last && last.role === 'assistant') {
              return [...prev.slice(0, -1), { ...last, content: assistantText }];
            }
            return [...prev, { role: 'assistant', content: assistantText, createdAt: Date.now() }];
          });
        }
        break; // success, exit retry loop
      } catch (err: any) {
        if (err.name === 'AbortError') {
          setMessages(prev => [...prev, { role: 'system', content: 'Cancelled', createdAt: Date.now() }]);
          break;
        }
        if (attempt === MAX_RETRIES) {
          setMessages(prev => [...prev, { role: 'system', content: `Error: ${err.message}`, createdAt: Date.now() }]);
        }
        break;
      }
    }

    setIsGenerating(false);
    setRetryCountdown(null);
    abortRef.current = null;
  };

  const clearChat = () => {
    setMessages([]);
    localStorage.removeItem(STORAGE_KEY);
  };

  const styles: Record<string, React.CSSProperties> = {
    body: { fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif', background: '#0d1117', color: '#c9d1d9', height: '100vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', margin: 0 },
    header: { padding: '12px 20px', borderBottom: '1px solid #30363d', background: '#161b22', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' },
    h1: { fontSize: 16, fontWeight: 600, color: '#c9d1d9', margin: 0 },
    subtitle: { fontSize: 12, color: '#8b949e' },
    configRow: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
    select: { background: '#0d1117', border: '1px solid #30363d', color: '#c9d1d9', padding: '6px 10px', borderRadius: 6, fontSize: 13, outline: 'none', minWidth: 140 },
    btn: { background: '#58a6ff', color: '#fff', border: 'none', padding: '6px 14px', borderRadius: 6, fontSize: 13, fontWeight: 500, cursor: 'pointer' },
    btnSecondary: { background: '#1c2128', color: '#c9d1d9', border: '1px solid #30363d', padding: '6px 14px', borderRadius: 6, fontSize: 13, fontWeight: 500, cursor: 'pointer' },
    chat: { flex: 1, overflowY: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 16 },
    message: { maxWidth: '85%', padding: '12px 16px', borderRadius: 12, lineHeight: 1.6, fontSize: 14, wordWrap: 'break-word' as any },
    userMsg: { alignSelf: 'flex-end', background: '#1f4d7a', borderBottomRightRadius: 4 },
    assistantMsg: { alignSelf: 'flex-start', background: '#21262d', border: '1px solid #30363d', borderBottomLeftRadius: 4 },
    systemMsg: { alignSelf: 'center', background: 'transparent', color: '#8b949e', fontSize: 12, padding: '4px 12px' },
    errorMsg: { alignSelf: 'center', background: 'rgba(248,81,73,0.1)', color: '#f85149', border: '1px solid rgba(248,81,73,0.3)' },
    label: { fontSize: 11, fontWeight: 600, marginBottom: 4, opacity: 0.7, textTransform: 'uppercase' as any, letterSpacing: '0.5px' },
    inputArea: { padding: '14px 20px', borderTop: '1px solid #30363d', background: '#161b22', display: 'flex', gap: 10, alignItems: 'flex-end' },
    textarea: { flex: 1, background: '#0d1117', border: '1px solid #30363d', color: '#c9d1d9', padding: '10px 14px', borderRadius: 10, fontSize: 14, resize: 'none' as any, outline: 'none', minHeight: 44, maxHeight: 200, fontFamily: 'inherit', lineHeight: 1.5 },
    sysToggle: { padding: '8px 20px', background: '#161b22', borderTop: '1px solid #30363d', display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', color: '#8b949e', fontSize: 12 },
    sysArea: { padding: '8px 20px', background: '#161b22', borderTop: '1px solid #30363d' },
    sysTextarea: { width: '100%', background: '#0d1117', border: '1px solid #30363d', color: '#c9d1d9', padding: '8px 12px', borderRadius: 6, fontSize: 13, resize: 'vertical' as any, minHeight: 60, fontFamily: 'inherit' },
    timestamp: { fontSize: 11, color: '#8b949e', marginTop: 6, textAlign: 'right' as any },
  };

  return (
    <div style={styles.body}>
      <header style={styles.header}>
        <div>
          <h1 style={styles.h1}>🐬 HIVEMIND Chat</h1>
          <div style={styles.subtitle}>Multi-model chat via OpenRouter</div>
        </div>
        <div style={styles.configRow}>
          <select style={styles.select} value={model} onChange={e => setModel(e.target.value)}>
            {MODELS.map(m => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>
          <button style={styles.btnSecondary} onClick={clearChat} disabled={isGenerating}>Clear</button>
        </div>
      </header>

      <div style={styles.sysToggle} onClick={() => setShowSystem(!showSystem)}>
        ⚙️ System prompt {showSystem ? '▾' : '▸'}
      </div>
      {showSystem && (
        <div style={styles.sysArea}>
          <textarea
            style={styles.sysTextarea}
            placeholder="Enter a system prompt to guide the assistant..."
            value={systemPrompt}
            onChange={e => setSystemPrompt(e.target.value)}
            rows={3}
          />
        </div>
      )}

      <div ref={chatRef} style={styles.chat}>
        {messages.length === 0 && (
          <div style={styles.systemMsg}>Welcome. Each browser gets its own chat history.</div>
        )}
        {messages.map((msg, i) => {
          const isUser = msg.role === 'user';
          const isSystem = msg.role === 'system';
          const isError = isSystem && msg.content.startsWith('Error:');
          const baseStyle = { ...styles.message };
          if (isUser) Object.assign(baseStyle, styles.userMsg);
          else if (isSystem) Object.assign(baseStyle, isError ? styles.errorMsg : styles.systemMsg);
          else Object.assign(baseStyle, styles.assistantMsg);

          return (
            <div key={i} style={baseStyle}>
              <div style={{ ...styles.label, color: isUser ? '#fff' : '#58a6ff' }}>
                {isUser ? 'You' : isSystem ? 'System' : 'Assistant'}
              </div>
              <div dangerouslySetInnerHTML={{ __html: formatText(msg.content) }} />
              <div style={styles.timestamp}>
                {new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </div>
            </div>
          );
        })}
        {isGenerating && messages[messages.length - 1]?.role !== 'assistant' && (
          <div style={{ ...styles.message, ...styles.assistantMsg }}>
            <div style={{ ...styles.label, color: '#58a6ff' }}>Assistant</div>
            <div style={{ display: 'flex', gap: 4, padding: '8px 0' }}>
              <span style={{ width: 7, height: 7, background: '#8b949e', borderRadius: '50%', animation: 'bounce 1.4s infinite ease-in-out both', animationDelay: '-0.32s' }} />
              <span style={{ width: 7, height: 7, background: '#8b949e', borderRadius: '50%', animation: 'bounce 1.4s infinite ease-in-out both', animationDelay: '-0.16s' }} />
              <span style={{ width: 7, height: 7, background: '#8b949e', borderRadius: '50%', animation: 'bounce 1.4s infinite ease-in-out both' }} />
            </div>
          </div>
        )}
      </div>

      <div style={styles.inputArea}>
        <textarea
          ref={textareaRef}
          style={styles.textarea}
          rows={1}
          placeholder="Type a message... (Shift+Enter for new line)"
          value={input}
          onChange={e => { setInput(e.target.value); adjustHeight(); }}
          onKeyDown={handleKeyDown}
          disabled={isGenerating}
        />
        <button style={styles.btn} onClick={sendMessage} disabled={isGenerating || !input.trim()}>
          {retryCountdown !== null ? `Retry in ${retryCountdown}s` : isGenerating ? '...' : 'Send'}
        </button>
      </div>

      <style jsx global>{`
        @keyframes bounce {
          0%, 80%, 100% { transform: scale(0); }
          40% { transform: scale(1); }
        }
        ::-webkit-scrollbar { width: 8px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #30363d; border-radius: 4px; }
      `}</style>
    </div>
  );
}
