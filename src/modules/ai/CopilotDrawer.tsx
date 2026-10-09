/**
 * AI Copilot drawer — a general assistant that works the LIVE CRM (and knows the Amaya project when the
 * company's plan includes the project library).
 *
 * Per message:
 *   AI configured  → Gemini (api.ai.chat) with the CRM tools + the project-documents search
 *                    → tool loop (≤ 4 rounds) → answer, plus a table of rows and/or an action proposal.
 *                    A failed request is retried once after ~1.5 s; if it still fails the user sees
 *                    calm quick-search results (or a calm one-liner) — never the raw error.
 *   AI unavailable → quickIntent() deterministic fallback (regex over live data)
 *
 * `context` (what the user has open — a lead card, a WhatsApp chat, a call) shapes the system prompt
 * ("Current context") and the quick-prompt chips above the input.
 *
 * The drawer never changes CRM data by itself: the model PROPOSES, the user
 * CONFIRMS, and the engine callbacks in `actions` do the work (optimistic +
 * toasts, like every other view).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Bot, Check, Copy, ExternalLink, Loader2, Mic, MicOff, Send, Sparkles, Trash2, User, Wand2, X } from 'lucide-react';
import type { ChatMessage, CopilotAction, InventoryUnit, Lead, TaskItem, UserAccount } from '../../types/crm';
import { F } from '../../core/config';
import { api } from '../../core/api';
import { formatTime, nowIso } from '../../core/dates';
import { reportError, toAppError } from '../../core/errors';
import { toast } from '../../core/notifications';
import { truncate } from '../../core/format';
import { Badge, Button, DataTable, InlineNotice, StageBadge, cx } from '../../components/ui';
import { audioRecorder } from '../../services/audioRecorder';
import { AMAYA_ASSISTANT_INTRO } from './amayaKnowledge';
import type { CopilotContext } from './copilotContext';
import {
  COPILOT_RETRY_DELAY_MS,
  GeminiContent,
  GeminiPart,
  ReadToolResult,
  SYSTEM_PROMPT,
  toolDeclarationsFor,
  ToolContext,
  buildActionProposal,
  contextLabel,
  copilotFailureKind,
  copilotFallback,
  executeReadTool,
  isActionTool,
  isProposalError,
  quickIntent,
  quickPromptsFor,
  resultTable,
  retryOnce,
} from './copilotTools';

/* ------------------------------------------------------------------------ */
/* Props (what the CRM shell passes)                                         */
/* ------------------------------------------------------------------------ */

export interface CopilotActions {
  addTask: (task: Omit<TaskItem, 'id'>) => Promise<TaskItem | null>;
  setLeadStage: (id: string, stage: string) => Promise<boolean>;
  appendRemark: (id: string, remark: string, nextFollowup?: string) => Promise<boolean>;
  updateLead: (id: string, patch: Partial<Lead>) => Promise<Lead | null>;
}

export interface CopilotDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  leads: Lead[];
  tasks: TaskItem[];
  inventory: InventoryUnit[];
  currentUser: UserAccount | null;
  aiConfigured: boolean;
  aiModel?: string;
  /** Sent once, automatically, when the drawer opens (Topbar search, "Suggest a reply", …). */
  prefill?: string;
  /** What the user has open (lead card / WhatsApp chat / call) — feeds the system prompt and the quick prompts. */
  context?: CopilotContext;
  canAct: boolean;
  actions: CopilotActions;
  onOpenLead: (id: string) => void;
  onShowLeads: (label: string, ids: string[]) => void;
  /** The company's plan includes the project library (Amaya knowledge + documents). Default true. */
  projectLibrary?: boolean;
  /** Company name for the generic prompt. */
  companyName?: string;
}

/* ------------------------------------------------------------------------ */
/* Constants                                                                 */
/* ------------------------------------------------------------------------ */

const MAX_MESSAGES = 60;
/** Tool-call rounds per user message before we stop and answer with what we have. */
const MAX_TOOL_ROUNDS = 4;
/** Gemini turns kept in the transcript (the backend slices to 40 anyway). */
const MAX_HISTORY = 40;

/** Intro without the project library: no project facts, just the CRM and general help. */
const GENERIC_ASSISTANT_INTRO =
  'I can work your CRM data — leads, follow-ups, tasks, inventory and RM performance — and help with drafts, calculations and general questions.';

const EXAMPLES = [
  'Show me all hot leads',
  'How many enquiries came this month?',
  'Which RM has the highest number of enquiries?',
  'Show leads not contacted for 7 days',
  'Compare this month with last month',
  "Show today's follow-ups",
];

const QUICK_SEARCH_HELP = [
  '- hot / warm / booked / qualified leads',
  "- today's follow-ups · overdue follow-ups",
  '- enquiries this month / last month / today',
  '- compare this month with last month',
  '- leads not contacted for 7 days',
  '- Instagram / Facebook / Website leads',
  '- pending tasks',
  '- find <name, phone or ID>',
  '- performance last month',
  '- which RM has the most enquiries',
].join('\n');

const NOT_CONFIGURED_TEXT = `I didn't recognise that as a quick search, and the AI assistant isn't configured yet — an administrator can add a Gemini API key under **Settings → Integrations → AI**.\n\nUntil then I can answer these directly from the live CRM:\n${QUICK_SEARCH_HELP}`;

const RETRY_NOTE = 'Still working on it — one moment…';

const newId = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

const modelMessage = (content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id: newId('m'),
  role: 'model',
  content,
  timestamp: nowIso(),
  ...extra,
});

interface Outcome {
  summary: string;
  result: 'completed' | 'cancelled by user' | 'failed';
}

interface GeminiReply {
  text: string;
  model?: string;
  pendingAction?: CopilotAction;
  lastResult?: ReadToolResult;
}

/**
 * Keep the transcript bounded and make sure it starts on a plain user turn —
 * Gemini rejects a functionResponse turn that has lost its functionCall turn.
 */
function trimHistory(history: GeminiContent[]): GeminiContent[] {
  const out = history.slice(-MAX_HISTORY);
  while (out.length > 1 && !(out[0].role === 'user' && out[0].parts.every((p) => !p.functionResponse))) out.shift();
  return out;
}

/** Stable identity for a context (App may pass a fresh object on every render). Empty when there is none. */
function contextKeyOf(c: CopilotContext | undefined): string {
  if (!c) return '';
  const parts = [c.view, c.leadId, c.chatPhone, c.callId, c.note].map((v) => String(v ?? '').trim());
  return parts.some(Boolean) ? parts.join('\u0001') : '';
}

/** Chat markdown → plain text for the clipboard, ready to paste into WhatsApp or an email. */
function plainText(md: string): string {
  return String(md || '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,4}\s+/gm, '')
    .trim();
}

/* ------------------------------------------------------------------------ */
/* Markdown-lite                                                              */
/* ------------------------------------------------------------------------ */

type Block = { type: 'p'; text: string } | { type: 'h'; text: string } | { type: 'ul'; items: string[] } | { type: 'ol'; items: string[] };

function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const bullet = line.match(/^(?:[-*•]|\d+[.)])\s+(.*)$/);
    if (bullet) {
      const type: 'ul' | 'ol' = /^\d/.test(line) ? 'ol' : 'ul';
      const last = blocks[blocks.length - 1];
      if (last && last.type === type) last.items.push(bullet[1]);
      else blocks.push({ type, items: [bullet[1]] });
      continue;
    }
    const heading = line.match(/^#{1,4}\s+(.*)$/);
    if (heading) {
      blocks.push({ type: 'h', text: heading[1] });
      continue;
    }
    blocks.push({ type: 'p', text: line });
  }
  return blocks;
}

function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  return text
    .split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
    .filter(Boolean)
    .map((part, i) => {
      const key = `${keyPrefix}-${i}`;
      if (part.length > 4 && part.startsWith('**') && part.endsWith('**')) return <strong key={key} className="font-bold">{part.slice(2, -2)}</strong>;
      if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) return <code key={key} className="font-mono text-[11px] px-1 py-0.5 rounded bg-black/5">{part.slice(1, -1)}</code>;
      return <React.Fragment key={key}>{part}</React.Fragment>;
    });
}

const MarkdownLite: React.FC<{ text: string }> = ({ text }) => {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  return (
    <div className="space-y-1.5 leading-relaxed break-words">
      {blocks.map((b, i) => {
        if (b.type === 'ul' || b.type === 'ol') {
          const Tag = b.type;
          return (
            <Tag key={i} className={cx('pl-4 space-y-0.5', b.type === 'ul' ? 'list-disc' : 'list-decimal')}>
              {b.items.map((item, j) => <li key={j}>{renderInline(item, `${i}-${j}`)}</li>)}
            </Tag>
          );
        }
        if (b.type === 'h') return <div key={i} className="font-bold">{renderInline(b.text, String(i))}</div>;
        return <p key={i}>{renderInline(b.text, String(i))}</p>;
      })}
    </div>
  );
};

/* ------------------------------------------------------------------------ */
/* Result table                                                               */
/* ------------------------------------------------------------------------ */

type Row = Record<string, string>;

const ResultTable: React.FC<{
  table: NonNullable<ChatMessage['table']>;
  label: string;
  onOpenLead: (id: string) => void;
  onShowLeads: (label: string, ids: string[]) => void;
  /** The company's plan includes the project library (Amaya knowledge + documents). Default true. */
  projectLibrary?: boolean;
  /** Company name for the generic prompt. */
  companyName?: string;
}> = ({ table, label, onOpenLead, onShowLeads }) => {
  const columns = useMemo(
    () =>
      table.columns.map((c) => ({
        key: c,
        label: c,
        render: (r: Row) => {
          const v = r[c] ?? '';
          if (c === 'ID' && r._leadId) {
            return (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenLead(r._leadId);
                }}
                className="font-mono font-semibold text-[#0B6BB0] hover:underline"
              >
                {v}
              </button>
            );
          }
          if (c === 'Stage') return <StageBadge stage={v} />;
          if (c === 'Status') return <Badge tone={v === 'Overdue' ? 'rust' : v === 'Completed' ? 'sage' : 'amber'}>{v}</Badge>;
          return <span className={cx(c === 'Name' && 'font-semibold text-[#0B2A44]', 'whitespace-nowrap')}>{v}</span>;
        },
      })),
    [table.columns, onOpenLead]
  );
  const leadIds = table.leadIds || [];
  const shownNote = table.rows.length < leadIds.length ? `Showing ${table.rows.length} of ${leadIds.length}` : `${table.rows.length} row${table.rows.length === 1 ? '' : 's'}`;
  return (
    <div className="mt-2 rounded-xl border border-[#D3E3F0] bg-white overflow-hidden">
      <DataTable<Row>
        dense
        columns={columns}
        rows={table.rows}
        keyFn={(r, i) => `${r._leadId || r.ID || ''}-${i}`}
        onRowClick={(r) => {
          if (r._leadId) onOpenLead(r._leadId);
        }}
        empty="No rows"
      />
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-t border-[#E6EFF6] bg-[#F7FAFD] text-[10px] text-[#5E778C]">
        <span>{shownNote}{leadIds.length ? ' · click a row to open the lead' : ''}</span>
        {leadIds.length > 0 && (
          <Button size="xs" variant="secondary" icon={<ExternalLink size={11} />} onClick={() => onShowLeads(label, leadIds)}>
            Open in All Leads
          </Button>
        )}
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------------ */
/* Action card                                                                */
/* ------------------------------------------------------------------------ */

const ActionCard: React.FC<{ action: CopilotAction; status: ChatMessage['status']; canAct: boolean; acting: boolean; onConfirm: () => void; onCancel: () => void }> = ({
  action, status = 'pending', canAct, acting, onConfirm, onCancel,
}) => (
  <div className={cx('mt-2 rounded-xl border p-3 space-y-2', action.destructive ? 'border-[#B06A55]/50 bg-[#FAF0EC]' : 'border-[#0B6BB0]/40 bg-[#F7FAFD]')}>
    <div className="flex items-center justify-between gap-2">
      <span className="inline-flex items-center gap-1.5 text-[10px] uppercase font-bold tracking-wider text-[#0B5E9C]">
        <Wand2 size={12} /> Proposed action
      </span>
      {status === 'pending' ? (
        action.destructive && <Badge tone="rust">Check carefully</Badge>
      ) : (
        <Badge tone={status === 'done' ? 'sage' : status === 'error' ? 'rust' : 'muted'}>{status === 'done' ? 'Done' : status === 'error' ? 'Failed' : 'Cancelled'}</Badge>
      )}
    </div>
    <div className="text-xs font-semibold text-[#0B2A44] leading-relaxed">{action.summary}</div>
    {status === 'pending' &&
      (canAct ? (
        <div className="flex items-center gap-2 pt-1">
          <Button size="xs" variant={action.destructive ? 'danger' : 'primary'} icon={<Check size={12} />} loading={acting} onClick={onConfirm}>
            Confirm
          </Button>
          <Button size="xs" variant="ghost" disabled={acting} onClick={onCancel}>
            Cancel
          </Button>
        </div>
      ) : (
        <InlineNotice tone="warning">Your role can't run CRM actions from the Copilot. Ask a manager, or make the change from All Leads.</InlineNotice>
      ))}
  </div>
);

/* ------------------------------------------------------------------------ */
/* Drawer                                                                     */
/* ------------------------------------------------------------------------ */

export const CopilotDrawer: React.FC<CopilotDrawerProps> = ({
  isOpen, onClose, leads, tasks, inventory, currentUser, aiConfigured, aiModel, prefill, context, canAct, actions, onOpenLead, onShowLeads, projectLibrary = true, companyName,
}) => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  /** Replaces the typing-bubble text while the single retry runs. */
  const [busyNote, setBusyNote] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [actingId, setActingId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  /** Key of a context the user detached with the chip's ×; a different context attaches again. */
  const [detachedKey, setDetachedKey] = useState<string | null>(null);

  /** Gemini transcript (user/model turns incl. functionCall / functionResponse parts). */
  const historyRef = useRef<GeminiContent[]>([]);
  /** Confirmed / cancelled proposals since the last message, so the model knows what happened. */
  const outcomesRef = useRef<Outcome[]>([]);
  const dataRef = useRef({ leads, tasks, inventory });
  dataRef.current = { leads, tasks, inventory };
  const contextKey = contextKeyOf(context);
  const activeContext = contextKey && detachedKey !== contextKey ? context : undefined;
  const contextRef = useRef<CopilotContext | undefined>(activeContext);
  contextRef.current = activeContext;
  const busyRef = useRef(false);
  const mountedRef = useRef(true);
  const prefillSentRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const userName = currentUser?.name || '';

  const getCtx = useCallback(
    (): ToolContext => ({ ...dataRef.current, now: new Date(), currentUser: userName, context: contextRef.current, projectLibrary, companyName }),
    [userName, projectLibrary, companyName]
  );

  const pushMessage = useCallback((m: ChatMessage) => setMessages((prev) => [...prev, m].slice(-MAX_MESSAGES)), []);
  const patchMessage = useCallback((id: string, patch: Partial<ChatMessage>) => setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m))), []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      audioRecorder.cancelRecording();
    };
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    // Capture phase on window: the drawer can open on top of the lead card, whose modal also closes on
    // Escape — only the top layer (this drawer) should close.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing) return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [isOpen, onClose]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, busy]);

  /* ------------------------------ Gemini loop ----------------------------- */

  const runGemini = useCallback(
    async (userText: string, ctx: ToolContext): Promise<GeminiReply> => {
      // Work on a copy: it is committed only when the whole exchange succeeds, so a
      // failed request never leaves a half-finished tool round in the transcript
      // (and the retry starts from the same clean transcript).
      let history: GeminiContent[] = [...historyRef.current, { role: 'user', parts: [{ text: userText }] }];
      let pendingAction: CopilotAction | undefined;
      let lastResult: ReadToolResult | undefined;
      let model: string | undefined;
      const commit = () => {
        historyRef.current = history;
      };
      for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
        history = trimHistory(history);
        const res = await api.ai.chat({
          contents: history,
          systemInstruction: SYSTEM_PROMPT(ctx),
          tools: [{ functionDeclarations: toolDeclarationsFor(ctx) }],
          model: aiModel || undefined,
        });
        // The backend reports the model that actually answered (it may fall back to a sibling when busy).
        model = res.model || aiModel;
        const candidate = res.candidates?.[0];
        const parts: GeminiPart[] = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
        if (!parts.length) {
          const reason = candidate?.finishReason ? ` (${candidate.finishReason})` : '';
          throw new Error(`Gemini returned no content${reason}`);
        }
        // Keep the model turn verbatim (thought signatures must round-trip).
        history.push({ role: 'model', parts });
        const calls = parts.filter((p) => p.functionCall && p.functionCall.name);
        const text = parts.map((p) => p.text || '').join('').trim();
        if (!calls.length) {
          commit();
          return { text, model, pendingAction, lastResult };
        }
        if (round === MAX_TOOL_ROUNDS) {
          // Answer the dangling calls so the transcript stays well-formed, then stop.
          history.push({
            role: 'user',
            parts: calls.map((p) => ({ functionResponse: { name: p.functionCall!.name, response: { result: { status: 'skipped', reason: 'Tool-call limit reached for this message.' } } } })),
          });
          commit();
          return { text: text || 'That needed more look-ups than I can do in one go — please narrow the question.', model, pendingAction, lastResult };
        }
        const responses: GeminiPart[] = calls.map((p) => {
          const { name, args } = p.functionCall!;
          if (isActionTool(name)) {
            if (pendingAction) {
              return { functionResponse: { name, response: { result: { status: 'rejected', reason: 'Only one action can be proposed per message. Ask the user to confirm the first one, then propose this.' } } } };
            }
            const proposal = buildActionProposal(name, args, ctx);
            if (isProposalError(proposal)) return { functionResponse: { name, response: { result: { status: 'error', ...proposal } } } };
            pendingAction = proposal;
            return { functionResponse: { name, response: { result: { status: 'awaiting_user_confirmation', proposal: proposal.summary } } } };
          }
          const result = executeReadTool(name, args, ctx);
          if (resultTable(result)) lastResult = result;
          return { functionResponse: { name, response: { result } } };
        });
        history.push({ role: 'user', parts: responses });
      }
      commit();
      return { text: '', model, pendingAction, lastResult };
    },
    [aiModel]
  );

  /* --------------------------------- send --------------------------------- */

  const send = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text || busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      setBusyNote(null);
      setInput('');
      if (textareaRef.current) textareaRef.current.style.height = 'auto';
      pushMessage({ id: newId('u'), role: 'user', content: text, timestamp: nowIso() });
      const ctx = getCtx();
      try {
        if (!aiConfigured) {
          const q = quickIntent(text, ctx);
          pushMessage(q ? modelMessage(q.text, { table: q.table }) : modelMessage(NOT_CONFIGURED_TEXT));
          return;
        }
        const outcomes = outcomesRef.current.splice(0);
        const prompt = outcomes.length
          ? `[App note — what happened to earlier proposals: ${outcomes.map((o) => `${o.result}: ${o.summary}`).join('; ')}]\n\n${text}`
          : text;
        let reply: GeminiReply;
        try {
          reply = await retryOnce(() => runGemini(prompt, ctx), {
            delayMs: COPILOT_RETRY_DELAY_MS,
            // Set-up / permission / session problems won't clear in 1.5 s — don't make the user wait for them.
            shouldRetry: (e) => copilotFailureKind(toAppError(e).code) === 'busy',
            isActive: () => mountedRef.current,
            onRetry: (e) => {
              reportError('ai.chat', e, { model: aiModel, attempt: 1, retrying: true });
              if (mountedRef.current) setBusyNote(RETRY_NOTE);
            },
          });
        } catch (e) {
          // Internal only (console + Error Log). The chat shows a calm fallback, never the error itself.
          const err = reportError('ai.chat', e, { model: aiModel });
          if (!mountedRef.current) return;
          // The model never saw these outcomes — carry them into the next message.
          outcomesRef.current.unshift(...outcomes);
          const fallback = copilotFallback(text, ctx, copilotFailureKind(err.code));
          pushMessage(modelMessage(fallback.content, { table: fallback.table, status: fallback.status }));
          return;
        }
        if (!mountedRef.current) return;
        const tbl = resultTable(reply.lastResult);
        const content =
          reply.text || (reply.pendingAction ? 'Please confirm the action below.' : tbl ? 'Here is what I found in the CRM.' : "I couldn't come up with an answer for that — please try rephrasing.");
        pushMessage(
          modelMessage(content, {
            model: reply.model,
            pendingAction: reply.pendingAction,
            status: reply.pendingAction ? 'pending' : undefined,
            table: tbl?.table,
          })
        );
      } finally {
        busyRef.current = false;
        if (mountedRef.current) {
          setBusy(false);
          setBusyNote(null);
        }
      }
    },
    [aiConfigured, aiModel, getCtx, pushMessage, runGemini]
  );

  // A prefilled question (Topbar search, "Suggest a reply" from a lead) is sent once, automatically,
  // with whatever context came with it.
  useEffect(() => {
    if (!isOpen || !prefill || prefillSentRef.current === prefill) return;
    prefillSentRef.current = prefill;
    void send(prefill);
  }, [isOpen, prefill, send]);

  /* -------------------------------- actions ------------------------------- */

  const confirmAction = useCallback(
    async (msg: ChatMessage) => {
      const action = msg.pendingAction;
      if (!action || !canAct || actingId) return;
      setActingId(msg.id);
      const a = action.args as Record<string, any>;
      let ok = false;
      try {
        switch (action.type) {
          case 'create_task': {
            const task = await actions.addTask({
              name: String(a.name || ''),
              lead: String(a.leadName || ''),
              leadId: a.leadId ? String(a.leadId) : undefined,
              datetime: String(a.datetime || ''),
              status: 'Pending',
              completed: false,
              checklist: [],
              assignedTo: String(a.assignedTo || userName || '') || undefined,
            });
            ok = !!task;
            break;
          }
          case 'update_lead_stage':
            ok = await actions.setLeadStage(String(a.leadId), String(a.stage));
            break;
          case 'add_remark':
            ok = await actions.appendRemark(String(a.leadId), String(a.remark), a.nextFollowup ? String(a.nextFollowup) : undefined);
            break;
          case 'schedule_followup':
            ok = !!(await actions.updateLead(String(a.leadId), { [F.NEXT_FOLLOWUP]: String(a.nextFollowup) }));
            break;
          case 'assign_rm':
            ok = !!(await actions.updateLead(String(a.leadId), { [F.RM]: String(a.rm) }));
            break;
          case 'update_lead':
            ok = !!(await actions.updateLead(String(a.leadId), (a.patch || {}) as Partial<Lead>));
            break;
          default:
            ok = false;
        }
      } catch (e) {
        reportError('ai.action', e, { type: action.type });
        ok = false;
      }
      if (!mountedRef.current) return;
      patchMessage(msg.id, { status: ok ? 'done' : 'error' });
      outcomesRef.current.push({ summary: action.summary, result: ok ? 'completed' : 'failed' });
      pushMessage(
        modelMessage(ok ? `Done: ${action.summary}.` : `Could not complete: ${action.summary}. The CRM rejected the change — see the notification for the reason, then try again.`, {
          status: ok ? 'done' : 'error',
        })
      );
      setActingId(null);
    },
    [actions, actingId, canAct, patchMessage, pushMessage, userName]
  );

  const cancelAction = useCallback(
    (msg: ChatMessage) => {
      if (!msg.pendingAction) return;
      patchMessage(msg.id, { status: 'cancelled' });
      outcomesRef.current.push({ summary: msg.pendingAction.summary, result: 'cancelled by user' });
      pushMessage(modelMessage('Cancelled — no changes were made.', { status: 'cancelled' }));
    },
    [patchMessage, pushMessage]
  );

  const clearConversation = () => {
    setMessages([]);
    historyRef.current = [];
    outcomesRef.current = [];
    setInput('');
  };

  const copyMessage = async (msg: ChatMessage) => {
    try {
      await navigator.clipboard.writeText(plainText(msg.content));
      setCopiedId(msg.id);
      window.setTimeout(() => {
        if (mountedRef.current) setCopiedId((id) => (id === msg.id ? null : id));
      }, 1600);
    } catch (e) {
      reportError('ai.copy', e);
      toast('Could not copy', 'Clipboard access was blocked by the browser.', 'warning');
    }
  };

  /* --------------------------------- voice -------------------------------- */

  const toggleVoice = async () => {
    if (recording) {
      setRecording(false);
      setTranscribing(true);
      try {
        const text = await audioRecorder.stopAndTranscribe();
        if (!mountedRef.current) return;
        if (text) setInput((prev) => (prev ? `${prev} ${text}` : text));
        else toast('Nothing transcribed', 'Try speaking a little longer.', 'warning');
      } catch (e) {
        reportError('ai.transcribe', e); // the detail goes to the error log, not to the user
        toast("Couldn't transcribe just now", 'Please try again in a few seconds, or type your question.', 'warning');
      } finally {
        if (mountedRef.current) setTranscribing(false);
      }
    } else {
      try {
        await audioRecorder.startRecording();
        if (mountedRef.current) setRecording(true);
      } catch (e) {
        const err = reportError('ai.microphone', e);
        toast('Microphone unavailable', err.userMessage, 'warning');
      }
    }
  };

  const onInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  };

  if (!isOpen) return null;

  const subtitle = aiConfigured ? `${projectLibrary ? 'Project knowledge · ' : ''}live CRM data${aiModel ? ` · ${aiModel}` : ''}` : 'Quick search mode · AI not configured';
  const chip = activeContext ? contextLabel(activeContext, leads) : null;
  const quickPrompts = aiConfigured ? quickPromptsFor(activeContext, { projectLibrary }) : [];
  const composerLocked = busy || recording || transcribing;
  let lastUserText = '';

  return (
    <>
      <div className="fixed inset-0 bg-[#0B2A44]/40 backdrop-blur-xs z-50" onClick={onClose} />
      <aside
        role="dialog"
        aria-label="CRM Copilot"
        className="fixed top-0 right-0 bottom-0 w-[560px] max-w-full bg-[#FFFFFF] z-50 shadow-2xl flex flex-col border-l border-[#D3E3F0] animate-in slide-in-from-right duration-200"
      >
        {/* Header */}
        <div className="p-4 border-b border-[#D3E3F0] bg-white flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-9 h-9 rounded-xl bg-[#0B6BB0] text-white flex items-center justify-center shadow-xs flex-shrink-0">
              <Sparkles size={18} />
            </div>
            <div className="min-w-0">
              <h3 className="text-base font-bold text-[#0B2A44] leading-tight">CRM Copilot</h3>
              <p className="text-[11px] text-[#5E778C] truncate">{subtitle}</p>
            </div>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            {messages.length > 0 && (
              <Button size="xs" variant="ghost" icon={<Trash2 size={12} />} onClick={clearConversation} disabled={busy} title="Clear conversation">
                Clear
              </Button>
            )}
            <button onClick={onClose} className="p-1.5 rounded-md text-[#7E93A6] hover:text-[#0B2A44] hover:bg-[#F2F7FB]" aria-label="Close">
              <X size={18} />
            </button>
          </div>
        </div>

        {/* What the Copilot is looking at */}
        {chip && (
          <div className="px-4 py-2 border-b border-[#E6EFF6] bg-[#F5F9FC] flex items-center gap-2 text-[11px] text-[#0B5E9C]">
            <Sparkles size={12} className="flex-shrink-0 text-[#0B6BB0]" />
            <span className="truncate min-w-0">
              Context: <strong className="font-semibold text-[#0B2A44]">{chip}</strong>
            </span>
            <button
              type="button"
              onClick={() => setDetachedKey(contextKey)}
              disabled={busy}
              className="ml-auto p-1 rounded-md text-[#7E93A6] hover:text-[#0B2A44] hover:bg-[#F2F7FB] disabled:opacity-40 flex-shrink-0"
              title="Stop using this context"
              aria-label="Stop using this context"
            >
              <X size={12} />
            </button>
          </div>
        )}

        {/* Thread */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4">
          {messages.length === 0 && (
            <div className="rounded-2xl border border-[#D3E3F0] bg-white p-4 space-y-3 shadow-2xs">
              <div className="flex items-start gap-3">
                <div className="w-8 h-8 rounded-full bg-[#0B6BB0] text-white flex items-center justify-center flex-shrink-0">
                  <Bot size={16} />
                </div>
                <div className="text-xs text-[#0F2233] leading-relaxed">
                  <div className="font-bold text-[#0B2A44] text-sm">Hello{userName ? `, ${userName.split(' ')[0]}` : ''}.</div>
                  {aiConfigured
                    ? `${projectLibrary ? AMAYA_ASSISTANT_INTRO : GENERIC_ASSISTANT_INTRO} I'll always ask you to confirm before changing a lead or creating a task.`
                    : "Ask me anything about the live pipeline, or tell me what to do — I'll always ask you to confirm before changing a lead or creating a task."}
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {EXAMPLES.map((ex) => (
                  <button
                    key={ex}
                    type="button"
                    disabled={busy}
                    onClick={() => void send(ex)}
                    className="px-2.5 py-1.5 rounded-full border border-[#D3E3F0] bg-[#F7FAFD] text-[11px] text-[#0B2A44] hover:bg-[#F2F7FB] hover:border-[#0B6BB0] transition text-left disabled:opacity-50"
                  >
                    {ex}
                  </button>
                ))}
              </div>
              {!aiConfigured && (
                <InlineNotice tone="warning">
                  The AI assistant isn't configured, so I'm running in quick-search mode (stage lists, follow-ups, counts, comparisons, RM leaderboard). An administrator can add a Gemini key under Settings → Integrations → AI.
                </InlineNotice>
              )}
            </div>
          )}

          {messages.map((msg) => {
            const isUser = msg.role === 'user';
            if (isUser) lastUserText = msg.content;
            const tableLabel = `Copilot: ${truncate(lastUserText || 'results', 40)}`;
            const copied = copiedId === msg.id;
            return (
              <div key={msg.id} className={cx('flex gap-2.5 text-xs leading-relaxed', isUser ? 'justify-end' : 'justify-start')}>
                {!isUser && (
                  <div className="w-7 h-7 rounded-full bg-[#0B6BB0] text-white flex items-center justify-center flex-shrink-0 mt-0.5">
                    <Bot size={14} />
                  </div>
                )}
                <div
                  className={cx(
                    'rounded-2xl p-3.5 shadow-2xs min-w-0',
                    isUser ? 'max-w-[85%] bg-[#0B2A44] text-white rounded-br-xs whitespace-pre-wrap break-words' : 'max-w-[92%] bg-white border border-[#D3E3F0] text-[#0F2233] rounded-bl-xs',
                    msg.status === 'error' && !msg.pendingAction && 'border-[#B06A55]/50 bg-[#FAF0EC] text-[#8A3E28]'
                  )}
                >
                  {isUser ? (
                    msg.content
                  ) : (
                    <div className="flex items-start gap-2">
                      {msg.status === 'done' && !msg.pendingAction && <Check size={14} className="text-[#3C573A] flex-shrink-0 mt-0.5" />}
                      {msg.status === 'error' && !msg.pendingAction && <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />}
                      <div className="min-w-0 flex-1">
                        <MarkdownLite text={msg.content} />
                      </div>
                    </div>
                  )}

                  {!isUser && msg.table && msg.table.rows.length > 0 && <ResultTable table={msg.table} label={tableLabel} onOpenLead={onOpenLead} onShowLeads={onShowLeads} />}

                  {!isUser && msg.pendingAction && (
                    <ActionCard
                      action={msg.pendingAction}
                      status={msg.status}
                      canAct={canAct}
                      acting={actingId === msg.id}
                      onConfirm={() => void confirmAction(msg)}
                      onCancel={() => cancelAction(msg)}
                    />
                  )}

                  <div className={cx('text-[9px] flex items-center justify-between gap-2 pt-1.5', isUser ? 'text-white/60' : 'text-[#7E93A6]')}>
                    <span>{formatTime(msg.timestamp)}</span>
                    {!isUser && (
                      <span className="flex items-center gap-1.5 min-w-0">
                        {msg.model && <span className="truncate">{msg.model}</span>}
                        {msg.content && !msg.pendingAction && !msg.status && (
                          <button
                            type="button"
                            onClick={() => void copyMessage(msg)}
                            className={cx('inline-flex items-center gap-1 rounded px-1 py-0.5 hover:text-[#0B2A44] hover:bg-[#F2F7FB] transition flex-shrink-0', copied && 'text-[#3C573A]')}
                            title="Copy this answer"
                            aria-label="Copy this answer"
                          >
                            {copied ? <Check size={11} /> : <Copy size={11} />}
                            {copied ? 'Copied' : 'Copy'}
                          </button>
                        )}
                      </span>
                    )}
                  </div>
                </div>
                {isUser && (
                  <div className="w-7 h-7 rounded-full bg-[#0B2A44] text-white flex items-center justify-center flex-shrink-0 mt-0.5">
                    <User size={14} />
                  </div>
                )}
              </div>
            );
          })}

          {busy && (
            <div className="flex gap-2.5 text-xs">
              <div className="w-7 h-7 rounded-full bg-[#0B6BB0] text-white flex items-center justify-center flex-shrink-0">
                <Loader2 size={14} className="animate-spin" />
              </div>
              <div className="bg-white border border-[#D3E3F0] px-3.5 py-2.5 rounded-2xl rounded-bl-xs text-[#5E778C] italic shadow-2xs">
                {busyNote || (aiConfigured ? 'Thinking…' : 'Searching…')}
              </div>
            </div>
          )}
        </div>

        {/* Composer */}
        <div className="p-3 border-t border-[#D3E3F0] bg-white">
          {quickPrompts.length > 0 && (
            <div className="flex gap-1.5 overflow-x-auto pb-2 -mx-0.5 px-0.5 [scrollbar-width:thin]" role="group" aria-label="Quick prompts">
              {quickPrompts.map((p) => (
                <button
                  key={p.text}
                  type="button"
                  disabled={composerLocked}
                  onClick={() => void send(p.text)}
                  className={cx(
                    'flex-shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded-full border text-[11px] whitespace-nowrap transition disabled:opacity-50',
                    p.contextual
                      ? 'border-[#0B6BB0]/50 bg-[#F5F9FC] text-[#0B5E9C] font-semibold hover:border-[#0B6BB0] hover:bg-[#F2F7FB]'
                      : 'border-[#D3E3F0] bg-[#F7FAFD] text-[#0B2A44] hover:border-[#0B6BB0] hover:bg-[#F2F7FB]'
                  )}
                >
                  {p.contextual && <Sparkles size={10} className="text-[#0B6BB0]" />}
                  {p.text}
                </button>
              ))}
            </div>
          )}
          <div className="flex items-end gap-2">
            {aiConfigured && (
              <button
                type="button"
                onClick={() => void toggleVoice()}
                disabled={transcribing || busy}
                className={cx(
                  'p-2.5 rounded-full transition flex items-center justify-center flex-shrink-0 disabled:opacity-50',
                  recording ? 'bg-[#B06A55] text-white animate-pulse' : transcribing ? 'bg-amber-100 text-amber-700' : 'bg-[#F2F7FB] text-[#0B2A44] hover:bg-[#E6EFF6]'
                )}
                title={recording ? 'Stop and transcribe' : transcribing ? 'Transcribing…' : 'Speak your question'}
                aria-label={recording ? 'Stop recording' : 'Start recording'}
              >
                {recording ? <MicOff size={16} /> : transcribing ? <Loader2 size={16} className="animate-spin" /> : <Mic size={16} />}
              </button>
            )}
            <textarea
              ref={textareaRef}
              rows={1}
              value={input}
              onChange={onInputChange}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send(input);
                }
              }}
              disabled={recording || transcribing}
              placeholder={
                recording
                  ? 'Listening…'
                  : transcribing
                    ? 'Transcribing…'
                    : aiConfigured
                      ? projectLibrary ? 'Ask anything — project facts, a WhatsApp draft, leads, follow-ups — or say what to do…' : 'Ask anything — a WhatsApp draft, leads, follow-ups — or say what to do…'
                      : "Quick search: hot leads, today's follow-ups, enquiries this month…"
              }
              className="flex-1 resize-none text-xs p-2.5 rounded-xl border border-[#D3E3F0] bg-[#F2F7FB] text-[#0B2A44] placeholder:text-[#7E93A6] focus:outline-none focus:border-[#0B6BB0] leading-relaxed max-h-[140px] disabled:text-[#7E93A6]"
            />
            <button
              type="button"
              onClick={() => void send(input)}
              disabled={!input.trim() || composerLocked}
              className="p-2.5 rounded-full bg-[#0B2A44] text-white hover:brightness-110 transition disabled:opacity-40 flex-shrink-0"
              title="Send (Enter)"
              aria-label="Send"
            >
              <Send size={15} />
            </button>
          </div>
          <div className="mt-1.5 flex items-center justify-between gap-2 text-[10px] text-[#7E93A6]">
            <span>{recording ? '● Recording — click the mic to stop and transcribe' : 'Enter to send · Shift+Enter for a new line'}</span>
            <span className="truncate">{canAct ? 'Actions need your confirmation' : 'Read-only for your role'}</span>
          </div>
        </div>
      </aside>
    </>
  );
};
