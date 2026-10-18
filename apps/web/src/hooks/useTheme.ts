import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ThemePreference } from '../types';

const STORAGE_KEY = 'overroot.theme';

export function useTheme() {
  const [preference, setPreferenceState] = useState<ThemePreference>(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system';
  });
  const [systemDark, setSystemDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches);

  useEffect(() => {
    const query = matchMedia('(prefers-color-scheme: dark)');
    const update = () => setSystemDark(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  const resolved = preference === 'system' ? (systemDark ? 'dark' : 'light') : preference;
  useEffect(() => {
    document.documentElement.dataset.theme = resolved;
    document.documentElement.style.colorScheme = resolved;
  }, [resolved]);

  const setPreference = useCallback((value: ThemePreference) => {
    localStorage.setItem(STORAGE_KEY, value);
    setPreferenceState(value);
  }, []);

  return useMemo(() => ({ preference, resolved, setPreference }), [preference, resolved, setPreference]);
}
