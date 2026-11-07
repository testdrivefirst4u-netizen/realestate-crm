/** In a chat on a direct WhatsApp connection: send an approved template, the only thing WhatsApp delivers after 24 hours of silence. */
import React, { useState } from 'react';
import { FileText } from 'lucide-react';
import { api, type WaDirectTemplate } from '../../core/api';
import { reportError, toAppError } from '../../core/errors';
import { Button, Field, InlineNotice, Modal, Select, inputCls } from '../../components/ui';

export const SendTemplateButton: React.FC<{ phone: string; leadId?: string; onSent: () => void }> = ({ phone, leadId, onSent }) => {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<WaDirectTemplate[] | null>(null);
  const [picked, setPicked] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const keyOf = (t: WaDirectTemplate) => `${t.name}:${t.language}`;
  const template = list?.find((t) => keyOf(t) === picked);

  const start = async () => {
    setOpen(true);
    setProblem('');
    setPicked('');
    setValues({});
    try {
      setList(await api.whatsappDirect.approvedTemplates());
    } catch (e) {
      setList([]);
      setProblem(toAppError(reportError('whatsappDirect.approved', e)).userMessage);
    }
  };
  const send = async () => {
    if (!template) return;
    setBusy(true);
    setProblem('');
    try {
      await api.chat360.send({ phone, leadId, templateName: template.name, templateLanguage: template.language, params: template.paramNames.map((n) => values[n] || '') });
      setOpen(false);
      onSent();
    } catch (e) {
      setProblem(toAppError(reportError('whatsappDirect.sendTemplate', e)).userMessage);
    } finally {
      setBusy(false);
    }
  };
  const preview = template ? template.body.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, n) => values[n]?.trim() || m) : '';

  return (
    <>
      <Button variant="secondary" size="xs" icon={<FileText size={12} />} onClick={() => void start()}>Send template</Button>
      {open && (
        <Modal open onClose={() => setOpen(false)} title="Send an approved template"
          footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" loading={busy} disabled={!template || template.paramNames.some((n) => !values[n]?.trim())} onClick={() => void send()}>Send</Button></>}>
          <div className="space-y-3">
            {list === null ? <p className="text-xs text-[#5E778C]">Loading…</p> : !list.length && !problem ? (
              <InlineNotice tone="info">No approved templates yet. An Admin can add them in Settings › WhatsApp direct, and Meta must approve them.</InlineNotice>
            ) : list.length > 0 && (
              <Field label="Template"><Select value={picked} onChange={(e) => { setPicked(e.target.value); setValues({}); }} placeholder="Choose" options={list.map((t) => ({ value: keyOf(t), label: `${t.name} (${t.language})` }))} /></Field>
            )}
            {template?.paramNames.map((n) => <Field key={n} label={`Value for {{${n}}}`}><input className={inputCls} value={values[n] || ''} maxLength={1000} onChange={(e) => setValues((v) => ({ ...v, [n]: e.target.value }))} /></Field>)}
            {template && <div className="whitespace-pre-wrap break-words rounded-lg bg-[#D9FDD3] p-3 text-[13px] text-[#111B21]">{preview}</div>}
            {problem && <InlineNotice tone="warning">{problem}</InlineNotice>}
          </div>
        </Modal>
      )}
    </>
  );
};
