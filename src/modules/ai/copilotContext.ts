/**
 * What the Copilot / Assist panel knows about where the user is in the app.
 * Views pass this when they open the Copilot ("Ask Copilot about this lead", "Suggest a reply"),
 * so the system prompt can reference the open record without the user re-typing it.
 */
export interface CopilotContext {
  /** Where the user is: 'lead' | 'chat' | 'call' | 'inventory' | 'dashboard' | … */
  view?: string;
  /** The open enquiry (Enquiry ID), when any. */
  leadId?: string;
  /** The open WhatsApp conversation (E.164 digits), when any. */
  chatPhone?: string;
  /** The open call record, when any. */
  callId?: string;
  /** Free text the view wants the assistant to know (e.g. the last 5 chat messages, a call transcript excerpt). */
  note?: string;
}

/** Signature of the app-level "open the Copilot" callback views receive. */
export type OpenCopilot = (prefill?: string, context?: CopilotContext) => void;
