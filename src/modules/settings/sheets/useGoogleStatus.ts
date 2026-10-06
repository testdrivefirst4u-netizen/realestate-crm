import { useCallback, useEffect, useState } from 'react';
import type { GoogleConnection, GoogleStatus } from '../../../../server/core/sheetTypes';
import { api } from '../../../core/api';
import { reportError, toAppError } from '../../../core/errors';

/** Platform Google status (service account + "Connect with Google") (loaded once per mount; skipped when `enabled` is false). */
export function useGoogleStatus(enabled: boolean): { status: GoogleStatus | null; error: string; loading: boolean; reload: () => void } {
  const [status, setStatus] = useState<GoogleStatus | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    try {
      setStatus(await api.sheets.googleStatus());
      setError('');
    } catch (e) {
      setError(toAppError(reportError('sheets.googleStatus', e)).userMessage);
    } finally {
      setLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    reload();
  }, [reload]);

  return { status, error, loading, reload };
}

/** Google accounts connected with "Connect with Google" (skipped when `enabled` is false, e.g. OAuth not set up). */
export function useGoogleConnections(enabled: boolean): { connections: GoogleConnection[] | null; error: string; loading: boolean; reload: () => Promise<void> } {
  const [connections, setConnections] = useState<GoogleConnection[] | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    try {
      setConnections(await api.sheets.connections());
      setError('');
    } catch (e) {
      setError(toAppError(reportError('sheets.connections', e)).userMessage);
    } finally {
      setLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    reload();
  }, [reload]);

  return { connections: enabled ? connections : null, error, loading, reload };
}
