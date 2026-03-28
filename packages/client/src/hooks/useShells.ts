import { useCallback, useEffect, useRef, useState } from "react";
import { api, type ShellInfo } from "../api/client";

const POLL_INTERVAL_MS = 3000;

export function useShells() {
  const [shells, setShells] = useState<ShellInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchShells = useCallback(async () => {
    try {
      const result = await api.getShells();
      setShells(result.shells);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchShells();
  }, [fetchShells]);

  useEffect(() => {
    timerRef.current = setInterval(() => {
      void fetchShells();
    }, POLL_INTERVAL_MS);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [fetchShells]);

  return { shells, loading, error, refetch: fetchShells };
}
